const winston = require('winston');
const nodemailer = require('nodemailer');
require('dotenv').config();
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
if (process.env.NODE_ENV === 'production') {
  console.log('Running in production mode');
  // Add any other production-specific code here if needed
}

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: 'bot.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      tailable: true,
    }),
    new winston.transports.Console(),
  ],
});

// Override console.log/error with logger
console.log = (...args) => logger.info(args.join(' '));
console.error = (...args) => logger.error(args.join(' '));

// Configure email alerts
const transporter = nodemailer.createTransport({
  service: 'gmail', // Use your email service (e.g., Gmail, Outlook)
  auth: {
    user: process.env.EMAIL_USER, // Add to .env
    pass: process.env.EMAIL_PASS, // Add app-specific password to .env
  },
});

function sendAlert(subject, message) {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_USER, // Or another alert email
    subject,
    text: message,
  };
  transporter.sendMail(mailOptions, (err) => {
    if (err) logger.error(`🚫 Email alert failed: ${err.message}`);
  });
}

const { Client, GatewayIntentBits, Events } = require('discord.js');
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const mongoose = require('mongoose');
const fs = require('fs').promises;
const app = express();

// Middleware to capture raw body for Stripe webhook
app.use(express.raw({ type: 'application/json' }));

mongoose.connect(process.env.MONGODB_URI).then(() => {
  logger.info('✅ Connected to MongoDB');
}).catch((err) => {
  logger.error('🚫 MongoDB connection error:', err.message);
  sendAlert('MongoDB Connection Failed', `Error: ${err.message}`);
});

const UserSchema = new mongoose.Schema({
  email: { type: String, lowercase: true, unique: true },
  discordId: { type: String, required: true },
});
const User = mongoose.model('User', UserSchema);

// Load or initialize verified users from JSON file (fallback)
let verifiedUsers = {};
const VERIFIED_USERS_FILE = './verifiedUsers.json';

async function loadVerifiedUsers() {
  try {
    const data = await fs.readFile(VERIFIED_USERS_FILE, 'utf8');
    verifiedUsers = JSON.parse(data);
  } catch (err) {
    logger.info('ℹ️ No existing verified users file, starting fresh');
    await saveVerifiedUsers();
  }
}

async function saveVerifiedUsers() {
  await fs.writeFile(VERIFIED_USERS_FILE, JSON.stringify(verifiedUsers, null, 2));
  // Sync with MongoDB
  for (const [email, discordId] of Object.entries(verifiedUsers)) {
    await User.updateOne({ email }, { $set: { discordId } }, { upsert: true });
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, c => {
  logger.info(`✅ Logged in as ${c.user.tag}`);
  loadVerifiedUsers();  // Load verified users inside ready event

  try {
    client.application.commands.create(
      {
        name: 'verify',
        description: 'Link your Stripe email to your Discord account',
        options: [
          {
            name: 'email',
            description: 'Your Stripe email address',
            type: 3,
            required: true,
          },
        ],
      },
      process.env.GUILD_ID
    );

    client.application.commands.create(
      {
        name: 'unverify',
        description: 'Unlink your Stripe email from your Discord account',
        options: [
          {
            name: 'email',
            description: 'The email to unlink',
            type: 3,
            required: true,
          },
        ],
      },
      process.env.GUILD_ID
    );

    client.application.commands.create(
      {
        name: 'checkpayment',
        description: 'Check your Stripe payment status to assign your role',
        options: [
          {
            name: 'email',
            description: 'The email used for your Stripe payment',
            type: 3,
            required: true,
          },
        ],
      },
      process.env.GUILD_ID
    );

    logger.info('📎 /verify, /unverify, and /checkpayment commands registered');
  } catch (err) {
    logger.error('❌ Error registering commands:', err.message);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const email = interaction.options.getString('email').toLowerCase();
  const userId = interaction.user.id;

  if (interaction.commandName === 'verify') {
    // Update MongoDB and JSON
    await User.findOneAndUpdate(
      { email },
      { email, discordId: userId },
      { upsert: true }
    );
    verifiedUsers[email] = userId;
    await saveVerifiedUsers();

    try {
      await interaction.reply({
        content: `✅ Verified! Your Discord account is now linked to ${email}. Run /checkpayment to activate your role if you already paid.`,
        flags: 64,
      });
    } catch (error) {
      logger.error('Reply error in /verify:', error.message);
    }

    logger.info(`🔗 Linked ${email} to Discord user ${interaction.user.tag}`);
  }

  if (interaction.commandName === 'unverify') {
    if (verifiedUsers[email] === userId) {
      // Update MongoDB and JSON
      await User.findOneAndDelete({ email, discordId: userId });
      delete verifiedUsers[email];
      await saveVerifiedUsers();

      try {
        await interaction.reply({
          content: `🧹 Unlinked ${email} from your Discord account.`,
          flags: 64,
        });
      } catch (error) {
        logger.error('Reply error in /unverify:', error.message);
      }
      logger.info(`🔓 Unlinked ${email} from ${interaction.user.tag}`);
    } else {
      try {
        await interaction.reply({
          content: `⚠️ That email isn't linked to your account.`,
          flags: 64,
        });
      } catch (error) {
        logger.error('Reply error in /unverify else:', error.message);
      }
    }
  }

  if (interaction.commandName === 'checkpayment') {
    if (verifiedUsers[email] !== userId) {
      try {
        await interaction.reply({
          content: `⚠️ That email isn't verified with your account. Run /verify first.`,
          flags: 64,
        });
      } catch (error) {
        logger.error('Reply error in /checkpayment if:', error.message);
      }
      return;
    }

    try {
      const customers = await stripe.customers.list({ email });
      if (!customers.data.length) {
        try {
          await interaction.reply({
            content: `⚠️ No Stripe customer found for ${email}. Ensure you used this email for payment.`,
            flags: 64,
          });
        } catch (error) {
          logger.error('Reply error in /checkpayment no customer:', error.message);
        }
        return;
      }

      let hasActivePayment = false;
      for (const customer of customers.data) {
        const subscriptions = await stripe.subscriptions.list({
          customer: customer.id,
          status: 'active',
        });
        if (subscriptions.data.length) {
          hasActivePayment = true;
          break;
        }
        const sessions = await stripe.checkout.sessions.list({
          customer: customer.id,
          limit: 10,
        });
        if (sessions.data.some((s) => s.payment_status === 'paid')) {
          hasActivePayment = true;
          break;
        }
      }

      if (!hasActivePayment) {
        try {
          await interaction.reply({
            content: `⚠️ No active subscription or completed payment found for ${email}.`,
            flags: 64,
          });
        } catch (error) {
          logger.error('Reply error in /checkpayment no payment:', error.message);
        }
        return;
      }

      const guild = client.guilds.cache.get(process.env.GUILD_ID);
      if (!guild) {
        logger.error('❌ Guild not found. Check GUILD_ID in .env');
        try {
          await interaction.reply({
            content: '⚠️ Server error. Please contact support.',
            flags: 64,
          });
        } catch (error) {
          logger.error('Reply error in /checkpayment guild:', error.message);
        }
        return;
      }

      await assignRole(email, guild);
      try {
        await interaction.reply({
          content: `✅ Payment verified! Member role assigned.`,
          flags: 64,
        });
      } catch (error) {
        logger.error('Reply error in /checkpayment success:', error.message);
      }
    } catch (err) {
      logger.error(`🚫 Check payment error for ${email}: ${err.message}`);
      try {
        await interaction.reply({
          content: '⚠️ Error checking payment. Please try again or contact support.',
          flags: 64,
        });
      } catch (error) {
        logger.error('Reply error in /checkpayment catch:', error.message);
      }
    }
  }
});

// Webhook handler setup
app.get('/health', async (req, res) => {
  const mongoConnected = mongoose.connection.readyState === 1;
  const discordReady = client?.user?.id ? true : false;

  const status = {
    mongo: mongoConnected ? '✅ Connected' : '❌ Disconnected',
    discord: discordReady ? `✅ Logged in as ${client.user.tag}` : '❌ Not logged in',
    timestamp: new Date().toISOString(),
  };

  logger.info(`🏥 Health check: ${JSON.stringify(status)}`);
  const allHealthy = mongoConnected && discordReady;
  res.status(allHealthy ? 200 : 500).json(status);
});

app.post('/webhook', async (req, res) => {
  logger.info(`🌐 Webhook received at /webhook - Body length: ${req.body.length}`);
  const sig = req.headers['stripe-signature'];
  if (!sig) {
    logger.error('🚨 No stripe-signature header value was provided.');
    return res.sendStatus(400);
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    logger.error('🚨 STRIPE_WEBHOOK_SECRET is not defined in .env');
    return res.sendStatus(500);
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    logger.error(`🚨 Webhook signature verification failed: ${err.message}`);
    return res.sendStatus(400);
  }

  try {
    logger.info(`📬 Webhook received: ${event.type}`);

    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) {
      logger.error('❌ Guild not found. Check GUILD_ID in .env');
      return res.sendStatus(400);
    }

    let email;
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        logger.info('🔍 Session object:', JSON.stringify(session, null, 2));
        email = session.customer_details?.email?.toLowerCase();
        if (!email && session.customer) {
          try {
            const customer = await stripe.customers.retrieve(session.customer);
            email = customer.email?.toLowerCase();
            logger.info(`📦 Fetched email from customer object: ${email}`);
          } catch (err) {
            logger.error('🚫 Failed to fetch customer email:', err.message);
          }
        }

        if (!email) {
          logger.error('⚠️ No email found in session or customer object');
          return res.sendStatus(200);
        }

        // Separate one-time vs subscription
        if (session.mode === 'payment') {  // One-time payment
          logger.info(`ℹ️ One-time payment for ${email} - No subscription role granted`);
        } else if (session.mode === 'subscription') {  // Recurring subscription
          logger.info(`💰 Subscription payment completed for: ${email}`);
          await assignRole(email, guild);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        email = invoice.customer_email?.toLowerCase();
        if (!email && invoice.customer) {
          try {
            const customer = await stripe.customers.retrieve(invoice.customer);
            email = customer.email?.toLowerCase();
            logger.info(`📦 Fetched email from customer object: ${email}`);
          } catch (err) {
            logger.error('🚫 Failed to fetch customer email:', err.message);
          }
        }

        if (!email) {
          logger.error('⚠️ No email found in invoice or customer object');
          return res.sendStatus(200);
        }

        logger.info(`💸 Recurring payment succeeded for: ${email}`);
        await assignRole(email, guild);
        break;
      }

      case 'invoice.payment_failed':
      case 'payment_intent.payment_failed':
      case 'customer.subscription.deleted': {
        const data = event.data.object;
        email = data.customer_email?.toLowerCase() || (data.charges?.data[0]?.billing_details?.email?.toLowerCase());
        if (!email && data.customer) {
          try {
            const customer = await stripe.customers.retrieve(data.customer);
            email = customer.email?.toLowerCase();
            logger.info(`📦 Fetched email from customer object: ${email}`);
          } catch (err) {
            logger.error('🚫 Failed to fetch customer email:', err.message);
          }
        }

        if (!email) {
          logger.error('⚠️ No email found in event data or customer object');
          return res.sendStatus(200);
        }

        logger.info(`${event.type === 'invoice.payment_failed' ? '❌ Payment failed' : event.type === 'payment_intent.payment_failed' ? '❌ Payment intent failed' : '🔻 Subscription canceled'} for: ${email}`);
        await handleFailedPayment(email, guild);
        break;
      }

      default:
        logger.info(`ℹ️ Unhandled event type: ${event.type}`);
    }

    res.sendStatus(200);
  } catch (error) {
    logger.error('🚨 Webhook error:', error.message);
    res.sendStatus(400);
  }
});

// Helper function to assign role
async function assignRole(email, guild) {
  const user = await User.findOne({ email });
  const userId = user?.discordId;
  if (!userId) {
    logger.warn(`⚠️ No verified Discord user for email: ${email}`);
    return;
  }

  try {
    const member = await guild.members.fetch(userId);
    const role = guild.roles.cache.get(process.env.ROLE_ID);

    logger.info(`👤 Target member: ${member?.user?.tag || 'Not found'}`);
    logger.info(`🎯 Found role: ${role?.name || 'Not found'}`);

    if (!role) {
      logger.error('❌ Role not found. Check ROLE_ID in .env');
      return;
    }

    if (!member) {
      logger.error('❌ Member not found in guild');
      return;
    }

    if (member.roles.cache.has(role.id)) {
      logger.info(`ℹ️ ${member.user.tag} already has role ${role.name}`);
      return;
    }

    await member.roles.add(role);
    logger.info(`✅ Added role '${role.name}' to ${member.user.tag}`);
  } catch (err) {
    logger.error(`🚫 Role assignment failed for ${email}: ${err.message}`);
  }
}

// Helper function for failed payments (role removal only)
async function handleFailedPayment(email, guild) {
  const user = await User.findOne({ email });
  const userId = user?.discordId;
  if (!userId) {
    logger.warn(`⚠️ No verified Discord user for email: ${email}`);
    return;
  }

  try {
    const member = await guild.members.fetch(userId);
    const role = guild.roles.cache.get(process.env.ROLE_ID);

    logger.info(`👤 Target member: ${member?.user?.tag || 'Not found'}`);
    logger.info(`🎯 Found role: ${role?.name || 'Not found'}`);

    if (!role) {
      logger.error('❌ Role not found. Check ROLE_ID in .env');
      return;
    }

    if (!member) {
      logger.error('❌ Member not found in guild');
      return;
    }

    if (!member.roles.cache.has(role.id)) {
      logger.info(`ℹ️ ${member.user.tag} does not have role ${role.name}`);
      return;
    }

    await member.roles.remove(role);
    logger.info(`✅ Removed role '${role.name}' from ${member.user.tag}`);

    // Notify user via DM
    try {
      await member.send(
        `Your payment for ${email} failed or your subscription was canceled. Your Member role has been removed, and you've lost access to private channels. Update your payment method in Stripe and run /checkpayment to restore access.`
      );
      logger.info(`📩 Sent DM to ${member.user.tag} about role removal`);
    } catch (err) {
      logger.error(`🚫 Failed to send DM to ${member.user.tag}: ${err.message}`);
    }
  } catch (err) {
    logger.error(`🚫 Failed payment handling error for ${email}: ${err.message}`);
  }
}

// Helper function to remove role (unchanged, kept for reference)
async function removeRole(email, guild) {
  const user = await User.findOne({ email });
  const userId = user?.discordId;
  if (!userId) {
    logger.warn(`⚠️ No verified Discord user for email: ${email}`);
    return;
  }

  try {
    const member = await guild.members.fetch(userId);
    const role = guild.roles.cache.get(process.env.ROLE_ID);

    logger.info(`👤 Target member: ${member?.user?.tag || 'Not found'}`);
    logger.info(`🎯 Found role: ${role?.name || 'Not found'}`);

    if (!role) {
      logger.error('❌ Role not found. Check ROLE_ID in .env');
      return;
    }

    if (!member) {
      logger.error('❌ Member not found in guild');
      return;
    }

    if (!member.roles.cache.has(role.id)) {
      logger.info(`ℹ️ ${member.user.tag} does not have role ${role.name}`);
      return;
    }

    await member.roles.remove(role);
    logger.info(`✅ Removed role '${role.name}' from ${member.user.tag}`);
  } catch (err) {
    logger.error(`🚫 Role removal failed for ${email}: ${err.message}`);
  }
}

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  logger.error('🚫 Discord login error:', error.message);
  sendAlert('Discord Login Failed', `Error: ${error.message}`);
});

const PORT = process.env.PORT || 10000; // Render default
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Webhook server running on port ${PORT}`);
});

// Add backup endpoint
app.get('/backup', (req, res) => {
  res.download(VERIFIED_USERS_FILE, 'verifiedUsers.json');
});