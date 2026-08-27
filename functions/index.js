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

// =================================
// REAL EMAIL VERIFICATION FUNCTION
// =================================

  exports.sendVerificationEmail = onRequest(
    {
      secrets: ["RESEND_API_KEY", "APP_URL"],
      cors: true,
    },

    async (req, res) => {

      try {

        const resend = new Resend(process.env.RESEND_API_KEY);

        const { email, uid, fullName } = req.body;

        if (!email || !uid) {
          return res.status(400).send({
            error: "Missing email or uid."
          });
        }

      const verificationLink =
        await admin.auth().generateEmailVerificationLink(email, {
          url: process.env.APP_URL,
          handleCodeInApp: false,
        });

        const emailResult = await resend.emails.send({

          from: "Lesovia <no-reply@lesovia.com>",

          to: email,

          subject: "Verify your Lesovia account",

          html: `

      <div style="font-family:Arial;padding:30px;max-width:600px;margin:auto;">

      <h1>Welcome to Lesovia!</h1>

      <p>Hello ${fullName || ""},</p>

      <p>
        Thank you for creating your Lesovia account.
      </p>

      <p>
        Please verify your email address before logging in.
      </p>

      <p style="margin:40px 0;">

      <a
      href="${verificationLink}"
      style="
        background:#1a73e8;
        color:white;
        padding:15px 30px;
        text-decoration:none;
        border-radius:6px;
        font-weight:bold;
      ">
        Verify My Email
      </a>

      </p>

      <p>
        If the button doesn't work, copy this link:
      </p>

      <p>

      ${verificationLink}

      </p>

      <hr>

      <p style="color:#777;">
      © 2026 Lesovia
      </p>

      </div>

          `,

        });
        logger.info("Resend response:", emailResult);

        res.send({

          success: true,

          message: "Verification email sent."

        });

      }

      catch (error) {

        logger.error(error);

        res.status(500).send({

          error: error.message

        });

      }

    }

  );


  // ===========================
// CUSTOM PASSWORD RESET EMAIL
// ===========================

exports.sendPasswordResetEmail = onRequest(
  {
    secrets: ["RESEND_API_KEY", "APP_URL"],
    cors: true,
  },
  async (req, res) => {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);

      const { email } = req.body;

      if (!email) {
        return res.status(400).send({
          error: "Email is required.",
        });
      }

      const resetLink = await admin.auth().generatePasswordResetLink(email, {
        url: process.env.APP_URL,
      });

      const emailResult = await resend.emails.send({
        from: "Lesovia <no-reply@lesovia.com>",
        to: email,
        subject: "Reset your Lesovia password",

        html: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:30px;">

<h1 style="color:#0b7a3d;">Reset Your Password</h1>

<p>Hello,</p>

<p>
We received a request to reset the password for your Lesovia account.
</p>

<p>
If you requested this change, click the button below.
</p>

<p style="margin:40px 0;text-align:center;">

<a
href="${resetLink}"
style="
background:#0b7a3d;
color:#ffffff;
padding:15px 30px;
text-decoration:none;
border-radius:6px;
font-weight:bold;
display:inline-block;
">
Reset Password
</a>

</p>

<p>
If you didn't request a password reset, you can safely ignore this email.
Your password will remain unchanged.
</p>

<hr>

<p style="color:#777;">
© 2026 Lesovia
</p>

</div>
`,
      });

      logger.info("Password reset email:", emailResult);

      res.send({
        success: true,
        message: "Password reset email sent.",
      });
    } catch (error) {
      logger.error(error);

      res.status(500).send({
        error: error.message,
      });
    }
  }
);