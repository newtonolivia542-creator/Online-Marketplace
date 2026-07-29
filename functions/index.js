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
const { Resend } = require("resend");

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

     const { search } = req.body;

    if (!search) {
      return res.status(400).send({
        error: "Search text is required."
      });
    }

    logger.info("AI Search:", search);

    const response = await client.responses.create({
      model: "gpt-5.5",
      input: `
    You are an AI shopping assistant for Lesovia.

    A customer entered the following search:

    "${search}"

    Extract the customer's shopping intent.

    Return ONLY valid JSON.

    Use this format:

    {
      "name": "",
      "category": "",
      "brand": "",
      "colors": [],
      "condition": "",
      "minPrice": null,
      "maxPrice": null,
      "keywords": []
    }

    Do not include explanations.
    Do not include markdown.
    Do not include anything except JSON.
    `
    });

    logger.info(response.output_text);

    //res.send({
     // filters: response.output_text
   //});

    const filters = JSON.parse(response.output_text);
//temporary replacing//
   // let query = db.collection("products");
    //const snapshot = await db.collection("products").get();
    const snapshot = await db.collection("products")
      .where("category", "==", "fashion")
      .get();
        logger.info("Number of products:", snapshot.size);

    const products = [];

    snapshot.forEach((doc) => {
      products.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    logger.info(products);

    res.send({
      products
    })

    // Filter by category
    /*if (filters.category) {
      query = query.where("category", "==", filters.category.toLowerCase());
    }

    // Filter by maximum price
    if (filters.maxPrice !== null) {
      query = query.where("price", "<=", filters.maxPrice);
    }

    const snapshot = await query.get();

    const products = [];

    snapshot.forEach((doc) => {
      products.push({
        id: doc.id,
        ...doc.data(),
      });
    });

    res.send({
      filters,
      products,
    });*/

    } catch (error) {

      logger.error(error);

      res.status(500).send({
        error: error.message
      });

    }

  }
);

// ===========================
// TEST EMAIL FUNCTION
// ===========================

exports.testEmailFunction = onRequest(
  {
    cors: true,
  },
  async (req, res) => {

    res.send({
      success: true,
      message: "Lesovia Email Function is working!"
    });

  }
);