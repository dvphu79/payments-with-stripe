import StripeService from './stripe.js';
import AppwriteService from './appwrite.js';
import { getStaticFile, interpolate, throwIfMissing } from './utils.js';
import Stripe from 'stripe';

export default async (context) => {
  const { req, res, log, error } = context;

  throwIfMissing(process.env, [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
  ]);

  const databaseId = process.env.APPWRITE_DATABASE_ID ?? 'orders';
  const collectionId = process.env.APPWRITE_COLLECTION_ID ?? 'orders';

  if (req.method === 'GET') {
    const html = interpolate(getStaticFile('index.html'), {
      APPWRITE_FUNCTION_API_ENDPOINT: process.env.APPWRITE_FUNCTION_API_ENDPOINT,
      APPWRITE_FUNCTION_PROJECT_ID: process.env.APPWRITE_FUNCTION_PROJECT_ID,
      APPWRITE_FUNCTION_ID: process.env.APPWRITE_FUNCTION_ID,
      APPWRITE_DATABASE_ID: databaseId,
      APPWRITE_COLLECTION_ID: collectionId,
    });

    return res.text(html, 200, { 'Content-Type': 'text/html; charset=utf-8' });
  } else if (req.method === 'POST') {
    switch (req.path) {
      case '/stripe-key':
        return res.json({ key: process.env.STRIPE_PUBLISHABLE_KEY });
      case '/create-payment-intent':
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        const { email, amount, currency } = req.body;
        const customer = await stripe.customers.create({ email });
        // Create a PaymentIntent with the order amount and currency.
        const params = {
          amount: amount,
          currency: currency,
          customer: customer.id,
          payment_method_options: {
            card: {
              request_three_d_secure: 'automatic',
            },
            sofort: {
              preferred_language: 'en',
            }, 
          },
          payment_method_types: ['card'],
        };
        try {
          const paymentIntent = await stripe.paymentIntents.create(params);
          // Send publishable key and PaymentIntent client_secret to client.
          return res.send({
            clientSecret: paymentIntent.client_secret,
          });
        } catch (error) {
          return res.send({
            error: error.raw.message,
          });
        }
      default:
        return res.text('Not Found', 404);
    }
  }

  const appwrite = new AppwriteService(context.req.headers['x-appwrite-key']);
  const stripe = new StripeService();

  switch (req.path) {
    case '/checkout':
      const fallbackUrl = req.scheme + '://' + req.headers['host'] + '/';

      const successUrl = req.body?.successUrl ?? fallbackUrl;
      const failureUrl = req.body?.failureUrl ?? fallbackUrl;

      const userId = req.headers['x-appwrite-user-id'];
      if (!userId) {
        error('User ID not found in request.');
        return res.redirect(failureUrl, 303);
      }

      const session = await stripe.checkoutPayment(
        context,
        userId,
        successUrl,
        failureUrl
      );
      if (!session) {
        error('Failed to create Stripe checkout session.');
        return res.redirect(failureUrl, 303);
      }

      context.log('Session:');
      context.log(session);

      log(`Created Stripe checkout session for user ${userId}.`);
      return res.redirect(session.url, 303);

    case '/webhook':
      const event = stripe.validateWebhook(context, req);
      if (!event) {
        return res.json({ success: false }, 401);
      }

      context.log('Event:');
      context.log(event);

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.metadata.userId;
        const orderId = session.id;

        await appwrite.createOrder(databaseId, collectionId, userId, orderId);
        log(
          `Created order document for user ${userId} with Stripe order ID ${orderId}`
        );
        return res.json({ success: true });
      }

      return res.json({ success: true });

    default:
      return res.text('Not Found', 404);
  }
};
