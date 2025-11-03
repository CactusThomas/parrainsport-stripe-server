// index.js — ParrainSport Stripe server
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const app = express();
const port = process.env.PORT || 8080;

// --- Clients
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
// client supabase avec service role (serveur uniquement)
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// --- Middlewares
app.set('trust proxy', true);
app.use(cors({ origin: '*'})); // MVP: ouvre tout. Restreins à ton domaine en prod.

// NB: ne PAS utiliser express.json() sur /webhook. On l'ajoute route par route.
app.use('/create-checkout-session', express.json());
app.use('/price', express.json());

// --- Healthcheck
app.get('/', (_req, res) => res.send('ParrainSport Stripe server OK'));

// --- Récupérer le prix courant (affichage dynamique côté front)
app.get('/price', async (_req, res) => {
  try {
    const price = await stripe.prices.retrieve(process.env.STRIPE_PRICE_ID);
    return res.json({
      amount: price.unit_amount,           // en centimes
      currency: price.currency,           // ex: 'eur'
      price_id: price.id
    });
  } catch (e) {
    console.error('Price error:', e);
    return res.status(500).json({ error: 'Unable to retrieve price' });
  }
});

// --- Créer une Checkout Session
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { userId, boostType = 'adherent', origin } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const success = (origin || 'https://app.parrainsport.fr') + '/success?session_id={CHECKOUT_SESSION_ID}';
    const cancel  = (origin || 'https://app.parrainsport.fr') + '/profile';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: success,
      cancel_url: cancel,
      client_reference_id: userId,                 // récupéré au webhook
      metadata: { user_id: userId, boost_type: boostType },
      locale: 'fr'
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error('Checkout error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// --- Webhook Stripe (RAW body obligatoire)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object; // Stripe.Checkout.Session
      const userId = s.client_reference_id || s.metadata?.user_id;
      const amount = s.amount_total ?? 0;
      const boostType = (s.metadata?.boost_type === 'coach') ? 'boost coach' : 'boost adherent';

      if (userId) {
        // 1) journaliser le paiement (ajoute une contrainte unique sur stripe_payment_id côté SQL)
        await admin.from('paiements').insert({
          id_utilisateur: userId,
          montant: amount,
          type: boostType,
          stripe_payment_id: s.id
        });

        // 2) activer le boost
        await admin.from('users').update({ est_boosté: true }).eq('id', userId);
      }
    }

    return res.status(200).end();
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).end();
  }
});

// --- Démarrage
app.listen(port, () => {
  console.log(`Stripe server listening on :${port}`);
});
