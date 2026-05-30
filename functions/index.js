/* 
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

const Stripe = require("stripe");

exports.createPaymentIntent = onRequest(
  {
    secrets: ["STRIPE_SECRET_KEY"],
  },

  async (req, res) => {

    try {

      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

      const paymentIntent = await stripe.paymentIntents.create({
        amount: 5000,
        currency: "usd",
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });

    } catch (error) {

      logger.error(error);

      res.status(500).send(error.message);

    }

  }
);
*/
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

const Stripe = require("stripe");

exports.createPaymentIntent = onRequest(
  {
    secrets: ["STRIPE_SECRET_KEY"],
    cors: true
  },

  async (req, res) => {

    try {

      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

      const paymentIntent = await stripe.paymentIntents.create({
        amount: 5000,
        currency: "usd",
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });

    } catch (error) {

      logger.error(error);

      res.status(500).send(error.message);

    }

  }
);