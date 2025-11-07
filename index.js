// index.js – serveur Render (ESM)
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
  ALLOW_ORIGIN,
  PUBLIC_BASE_URL = 'https://parrainagesport.fr'
} = process.env;

// --- Vérifs env
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants');
  process.exit(1);
}

const app = express();
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// --- CORS (autorisé pour ton front + dev)
app.use(cors({
  origin: ALLOW_ORIGIN ? [ALLOW_ORIGIN, CLIENT_BASE_URL] : true,
  credentials: true
}));

// --- Racine simple
app.get('/', (_req, res) => {
  res.send('Stripe + SEO server up');
});

/* =========================
   ROBOTS.TXT & SITEMAP.XML
   ========================= */

// robots.txt
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain');
  res.send(`User-agent: *
Allow: /
Sitemap: ${PUBLIC_BASE_URL.replace(/\/+$/,'')}/sitemap.xml
`);
});

// Utilitaire XML simple
const xmlEscape = (s) =>
  String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

// sitemap.xml – génère dynamiquement les URLs
app.get('/sitemap.xml', async (_req, res) => {
  try {
    // Pages “statiques” (si tu en as d’autres, ajoute-les ici)
    const staticUrls = [
      { loc: `${PUBLIC_BASE_URL}/`, changefreq: 'weekly', priority: 0.8 },
    ];

    // Profils publics actifs (coach + adhérent)
    const { data: users, error } = await supabase
      .from('users')
      .select('id, updated_at')
      .in('type_utilisateur', ['coach', 'adherent'])
      .eq('status', 'active')
      .limit(5000);
    if (error) throw error;

    // Construit le XML
    const urlsXml = [
      ...staticUrls.map(u => `
  <url>
    <loc>${xmlEscape(u.loc)}</loc>
    ${u.changefreq ? `<changefreq>${u.changefreq}</changefreq>` : ''}
    ${u.priority ? `<priority>${u.priority}</priority>` : ''}
  </url>`).join(''),
      ...(users ?? []).map(u => `
  <url>
    <loc>${xmlEscape(`${PUBLIC_BASE_URL.replace(/\/+$/,'')}/p/${u.id}`)}</loc>
    ${u.updated_at ? `<lastmod>${new Date(u.updated_at).toISOString()}</lastmod>` : ''}
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>`).join('')
    ].join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset
  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:xhtml="http://www.w3.org/1999/xhtml"
>
${urlsXml}
</urlset>`;

    // Cache 1h
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('application/xml').send(xml);
  } catch (e) {
    console.error('sitemap error:', e);
    res.status(500).send('sitemap unavailable');
  }
});

/* =========================
   STRIPE – ABONNEMENT BOOST
   ========================= */

if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID || !STRIPE_WEBHOOK_SECRET) {
  console.warn('⚠️ Stripe env non complet : routes Stripe actives mais risque d’erreurs.');
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' }) : null;

// Webhook Stripe (raw body)
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(501).send('Stripe not configured');
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
        const userId = session.client_reference_id;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        if (userId && customerId) {
          await supabase.from('users').update({
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            est_booste: true
          }).eq('id', userId);
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        const subscriptionId = inv.subscription;
        if (subscriptionId) {
          await supabase.from('users').update({ est_booste: true })
            .eq('stripe_subscription_id', subscriptionId);
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const active = ['active', 'trialing', 'past_due'].includes(sub.status);
        await supabase.from('users').update({
          stripe_subscription_id: sub.id,
          est_booste: active
        }).eq('stripe_subscription_id', sub.id);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabase.from('users').update({ est_booste: false })
          .eq('stripe_subscription_id', sub.id);
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

// JSON body pour les autres routes Stripe
app.use(express.json());

// Checkout Session (subscription)
app.post('/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) return res.status(501).json({ error: 'Stripe not configured' });
    const { userId, email } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // customer
    const { data: u } = await supabase.from('users').select('stripe_customer_id').eq('id', userId).maybeSingle();
    let customerId = u?.stripe_customer_id ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: email || undefined, metadata: { userId } });
      customerId = customer.id;
      await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', userId);
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${CLIENT_BASE_URL.replace(/\/+$/,'')}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CLIENT_BASE_URL.replace(/\/+$/,'')}/profil`,
      client_reference_id: userId,
      metadata: { origin: 'parrainsport-boost' }
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('create-checkout-session error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

// Portail client (gestion abonnement)
app.post('/create-portal-session', async (req, res) => {
  try {
    if (!stripe) return res.status(501).json({ error: 'Stripe not configured' });
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const { data: u, error } = await supabase.from('users').select('stripe_customer_id').eq('id', userId).maybeSingle();
    if (error || !u?.stripe_customer_id) return res.status(400).json({ error: 'No customer' });

    const portal = await stripe.billingPortal.sessions.create({
      customer: u.stripe_customer_id,
      return_url: `${CLIENT_BASE_URL.replace(/\/+$/,'')}/profil`
    });

    res.json({ url: portal.url });
  } catch (e) {
    console.error('create-portal-session error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
