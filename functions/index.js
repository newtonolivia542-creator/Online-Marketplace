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
const OpenAI = require("openai").default;
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();

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

exports.generateProductDescription = onRequest(
  {
    secrets: ["OPENAI_API_KEY"],
    cors: true,
  },

  async (req, res) => {
    try {
      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });

      const {
        productName,
        brand,
        color,
        size,
        category,
        condition,
        price
    } = req.body;

      if (!productName || !category || !condition || !price) {
        return res.status(400).send({
          error: "Missing required product information.",
        });
      }

      logger.info("Generating AI description for:", productName);

      const response = await client.responses.create({
        model: "gpt-5.5",
        input: `
You are an expert e-commerce copywriter.

Write a professional marketplace product description.

Product Name: ${productName}
Brand: ${brand}
Color: ${color}
Size: ${size}
Category: ${category}
Condition: ${condition}
Price: ${price}

Requirements:
- 10–30 words only.
- Keep it concise and easy to read.
- Professional and friendly tone.
- Mention the condition naturally.
- Do not invent features.
- Focus on helping buyers understand the product quickly.
`,
      });

      res.send({
        description: response.output_text,
      });

    } catch (error) {

      logger.error(error);

      res.status(500).send({
        error: error.message,
      });

    }
  }
);

   //AI SEARCH FUNCTION//
exports.aiSearchProducts = onRequest(
  {
    secrets: ["OPENAI_API_KEY"],
    cors: true,
  },

  async (req, res) => {

    try {

      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });

      // We will continue here...

    } catch (error) {

      logger.error(error);

      res.status(500).send({
        error: error.message
      });

    }

  }
);