import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const app = express();
const port = process.env.PORT || 8080;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

// ----- Create Checkout Session (JSON body)
app.use('/create-checkout-session', express.json());
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { userId, boostType = 'adherent', origin = 'https://app.parrainsport.fr' } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/profile`,
      client_reference_id: userId,
      metadata: { user_id: userId, boost_type: boostType },
      locale: 'fr'
    });
    return res.json({ url: session.url });
  } catch (e) { 
    console.error(e);
    return res.status(500).json({ error: e.message }); 
  }
});

// ----- Webhook (RAW body obligatoire)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const userId = s.client_reference_id || s.metadata?.user_id;
      const amount = s.amount_total ?? 0;
      const boostType = s.metadata?.boost_type === 'coach' ? 'boost coach' : 'boost adherent';

      if (userId) {
        const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        // 1) log paiement (idempotence: ajouter contrainte unique côté SQL)
        await admin.from('paiements').insert({
          id_utilisateur: userId,
          montant: amount,
          type: boostType,
          stripe_payment_id: s.id
        });
        // 2) activer boost
        await admin.from('users').update({ est_boosté: true }).eq('id', userId);
      }
    }
    return res.status(200).end();
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

app.get('/', (_, res) => res.send('ParrainSport Stripe server OK'));
app.listen(port, () => console.log(`Listening on :${port}`));
