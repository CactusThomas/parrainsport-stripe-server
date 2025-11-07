// index.js (Render - Express)
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';

const {
  PORT = 10000,
  STRIPE_SECRET_KEY,
  STRIPE_PRICE_ID,
  STRIPE_WEBHOOK_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  CLIENT_BASE_URL = 'http://localhost:5173',
  ALLOW_ORIGIN
} = process.env;

if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID || !STRIPE_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing env vars.');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const app = express();

// CORS
app.use(cors({
  origin: ALLOW_ORIGIN ? [ALLOW_ORIGIN, CLIENT_BASE_URL] : true,
  credentials: true
}));

app.get('/', (req, res) => res.send('Stripe subscription server up'));

// ⚠️ Webhook doit lire le raw body
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verify failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        // Récupère l’ID utilisateur passé en client_reference_id
        const userId = session.client_reference_id;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        if (userId && customerId) {
          await supabase.from('users')
            .update({
              stripe_customer_id: customerId,
              stripe_subscription_id: subscriptionId,
              est_booste: true
            })
            .eq('id', userId);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        // paiement récurrent ok => est_booste true
        const inv = event.data.object;
        const subscriptionId = inv.subscription;
        if (subscriptionId) {
          await supabase.from('users')
            .update({ est_booste: true })
            .eq('stripe_subscription_id', subscriptionId);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const subscriptionId = sub.id;
        const status = sub.status; // active | past_due | canceled | unpaid | incomplete | incomplete_expired | trialing
        const active = ['active', 'trialing', 'past_due'].includes(status);

        await supabase.from('users')
          .update({
            stripe_subscription_id: subscriptionId,
            est_booste: active
          })
          .eq('stripe_subscription_id', subscriptionId);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const subscriptionId = sub.id;
        await supabase.from('users')
          .update({ est_booste: false })
          .eq('stripe_subscription_id', subscriptionId);
        break;
      }

      default:
        // noop
        break;
    }

    res.json({ received: true });
  } catch (e) {
    console.error('Webhook handler error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

// JSON body pour les autres routes
app.use(express.json());

// Crée une Checkout Session (mode abo)
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { userId, email } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // Tente de retrouver un customer existant
    const { data: userRow } = await supabase
      .from('users').select('stripe_customer_id').eq('id', userId).maybeSingle();

    let customerId = userRow?.stripe_customer_id ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: email || undefined,
        metadata: { userId }
      });
      customerId = customer.id;
      await supabase.from('users')
        .update({ stripe_customer_id: customerId })
        .eq('id', userId);
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${CLIENT_BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CLIENT_BASE_URL}/profil`,
      client_reference_id: userId,
      // facultatif : pour savoir d’où vient l’achat
      metadata: { origin: 'parrainsport-boost' }
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error('create-checkout-session error:', e);
    return res.status(500).json({ error: 'server error' });
  }
});

// Lien portail client (gestion abonnement)
app.post('/create-portal-session', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const { data: u, error } = await supabase
      .from('users').select('stripe_customer_id').eq('id', userId).maybeSingle();
    if (error || !u?.stripe_customer_id) return res.status(400).json({ error: 'No customer' });

    const portal = await stripe.billingPortal.sessions.create({
      customer: u.stripe_customer_id,
      return_url: `${CLIENT_BASE_URL}/profil`
    });

    res.json({ url: portal.url });
  } catch (e) {
    console.error('create-portal-session error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Stripe sub server listening on :${PORT}`);
});
