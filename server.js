require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/gearbari';
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('GearBari DB Connected Successfully!');
    autoSeedIfEmpty();
  })
  .catch(err => console.error('MongoDB Connection Error:', err));

// ==================== SCHEMAS ====================

// Product Schema
const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, required: true },
  category: { 
    type: String, 
    enum: ['Phones', 'Phone Accessories', 'PC Accessories', 'Gadgets'],
    required: true 
  },
  image: String,
  badge: String,
  stock: { type: Number, default: 10 }
}, { timestamps: true });

// User Schema (extended with name and phone)
// NOTE: phone is the true unique identity for a customer (two different people can
// share the same name, but not the same phone number). username is kept for
// backwards-compatible login (name + phone combo) but phone is what we use to
// find/link a returning customer's orders together.
const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['customer', 'admin'], default: 'customer' },
  name: { type: String },
  phone: { type: String, unique: true, sparse: true }
});

// Order Schema (extended with customerId and invoiceNumber)
const orderSchema = new mongoose.Schema({
  items: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: String,
    price: Number,
    quantity: Number
  }],
  totalAmount: Number,
  deliveryCharge: Number,
  deliveryOption: String,
  customerName: String,
  customerPhone: String,
  customerAddress: String,
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  invoiceNumber: { type: String, unique: true },
  status: { type: String, enum: ['Pending', 'In Shipping', 'Delivered'], default: 'Pending' }
}, { timestamps: true });

// Counter Schema for invoice numbers
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 }
});

const Product = mongoose.model('Product', productSchema);
const User = mongoose.model('User', userSchema);
const Order = mongoose.model('Order', orderSchema);
const Counter = mongoose.model('Counter', counterSchema);

const JWT_SECRET = process.env.JWT_SECRET || 'gearbari_super_secret_key_123';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'GearbariAdmin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const LOW_STOCK_THRESHOLD = 5;

// Escapes regex special characters so a name can be safely used inside a
// case-insensitive $regex match without accidentally building a broken (or
// exploitable) regular expression.
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Signs a customer JWT that also carries display name/phone, so the
// front-end can show "Hello, <name>" and build an account page without an
// extra round trip.
function signCustomerToken(user) {
  return jwt.sign(
    { username: user.username, role: 'customer', name: user.name, phone: user.phone },
    JWT_SECRET
  );
}

// ==================== MIDDLEWARE ====================

// Verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
};

// Admin role check
const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
};

// ==================== PUBLIC API ENDPOINTS ====================

// 1. Get Products (filter by category or search)
app.get('/api/products', async (req, res) => {
  try {
    const filter = {};
    if (req.query.category && req.query.category !== 'All') {
      filter.category = req.query.category;
    }
    if (req.query.search) {
      filter.name = { $regex: req.query.search, $options: 'i' };
    }
    const products = await Product.find(filter).sort({ createdAt: -1 });
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1b. Lightweight live-stock check (polled by the storefront every few
// seconds) - returns just id/stock pairs for the visible cards instead of
// the full product payload (images, descriptions, etc.), so it stays cheap
// even if it's called often to keep stock numbers "live".
app.get('/api/products/stock', async (req, res) => {
  try {
    const ids = (req.query.ids || '').split(',').filter(Boolean);
    if (ids.length === 0) return res.json([]);
    const products = await Product.find({ _id: { $in: ids } }, 'stock');
    res.json(products.map(p => ({ _id: p._id, stock: p.stock })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. User Login (Admin or Customer)
app.post('/api/auth/login', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = (req.body.password || '').trim();

    // Admin check - name is not case sensitive here either, just kept exact
    // for the password since it's a real secret, not a person's name.
    if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase() && password === ADMIN_PASSWORD) {
      const token = jwt.sign({ username: ADMIN_USERNAME, role: 'admin' }, JWT_SECRET);
      return res.json({ token, role: 'admin', username: ADMIN_USERNAME });
    }

    // Customer check (from database) - name + phone combo.
    // Names are matched case-insensitively ("karim" and "Karim" are the same
    // person) since phone number is what actually identifies a customer.
    const user = await User.findOne({
      username: { $regex: `^${escapeRegex(username)}$`, $options: 'i' },
      password: password
    });
    if (user) {
      const token = signCustomerToken(user);
      return res.json({ token, role: user.role, username: user.username, name: user.name, phone: user.phone });
    }

    res.status(400).json({ error: 'Invalid credentials. Please check your name and phone.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Register New Customer
app.post('/api/auth/register', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const phone = (req.body.phone || '').trim();
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required.' });
    }
    
    // Phone number is the real unique identity - two different customers can
    // share a name, but never a phone number.
    let user = await User.findOne({ phone });
    if (user) {
      return res.status(400).json({ error: 'This phone number is already registered. Please login instead.' });
    }
    
    // Create new user (username = name, password = phone)
    user = new User({ 
      username: name, 
      password: phone, 
      name, 
      phone, 
      role: 'customer' 
    });
    await user.save();

    const token = signCustomerToken(user);
    res.json({ token, role: 'customer', username: user.username, name: user.name, phone: user.phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Place Order (with auto-registration and invoice)
app.post('/api/orders', async (req, res) => {
  try {
    const { items, deliveryOption } = req.body;
    const customerName = (req.body.customerName || '').trim();
    const customerPhone = (req.body.customerPhone || '').trim();
    const customerAddress = (req.body.customerAddress || '').trim();

    // Validate required fields
    if (!items || items.length === 0 || !deliveryOption || !customerName || !customerPhone || !customerAddress) {
      return res.status(400).json({ error: 'Missing required order fields.' });
    }

    // Validate every item has a sane, positive integer quantity (prevents
    // negative-quantity abuse that would otherwise inflate stock).
    for (const item of items) {
      if (!item.productId || !Number.isInteger(item.quantity) || item.quantity < 1) {
        return res.status(400).json({ error: 'Each order item needs a valid productId and a quantity of at least 1.' });
      }
    }

    // Find or create customer - phone number is the real unique identity,
    // so two different people who happen to share a name never get merged
    // into the same account/order-history.
    let customer = await User.findOne({ phone: customerPhone });
    if (!customer) {
      customer = new User({ 
        username: customerName, 
        password: customerPhone, 
        name: customerName, 
        phone: customerPhone, 
        role: 'customer' 
      });
      await customer.save();
    }

    // Determine delivery charge
    let deliveryCharge = 0;
    if (deliveryOption === 'Inside Dhaka') deliveryCharge = 80;
    else if (deliveryOption === 'Outside Dhaka') deliveryCharge = 100;
    else return res.status(400).json({ error: 'Invalid delivery option.' });

    // Calculate total and atomically reserve stock for every item.
    // Using findOneAndUpdate with a stock >= quantity guard (instead of
    // read -> check -> save) prevents two simultaneous orders from both
    // "seeing" enough stock and overselling the last unit.
    let totalAmount = 0;
    const orderItems = [];
    const reservedProductIds = []; // for rollback if a later item fails

    try {
      for (const item of items) {
        const product = await Product.findOneAndUpdate(
          { _id: item.productId, stock: { $gte: item.quantity } },
          { $inc: { stock: -item.quantity } },
          { new: true }
        );
        if (!product) {
          const existing = await Product.findById(item.productId);
          if (!existing) throw { status: 404, message: `Product ${item.productId} not found.` };
          throw { status: 400, message: `Insufficient stock for ${existing.name}. Available: ${existing.stock}` };
        }
        reservedProductIds.push({ id: product._id, qty: item.quantity });

        totalAmount += product.price * item.quantity;
        orderItems.push({
          productId: product._id,
          name: product.name,
          price: product.price,
          quantity: item.quantity
        });
      }
    } catch (stockErr) {
      // Roll back any stock we already reserved before this item failed.
      for (const r of reservedProductIds) {
        await Product.findByIdAndUpdate(r.id, { $inc: { stock: r.qty } });
      }
      return res.status(stockErr.status || 500).json({ error: stockErr.message || 'Stock reservation failed.' });
    }

    // Add delivery charge
    totalAmount += deliveryCharge;

    // Generate invoice number
    const counter = await Counter.findByIdAndUpdate(
      { _id: 'invoice' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    const invoiceNumber = `INV${String(counter.seq).padStart(4, '0')}`;

    // Create order
    const newOrder = new Order({
      items: orderItems,
      totalAmount,
      deliveryCharge,
      deliveryOption,
      customerName,
      customerPhone,
      customerAddress,
      customerId: customer._id,
      invoiceNumber,
      status: 'Pending'
    });
    await newOrder.save();

    // Auto-login the customer under their (new or existing) account, so the
    // checkout flow lands them straight in their account/order-history page
    // instead of leaving them logged out after ordering as a guest.
    const token = signCustomerToken(customer);

    res.status(201).json({
      message: 'Order placed successfully!',
      order: newOrder,
      invoiceNumber,
      token,
      role: 'customer',
      username: customer.username,
      name: customer.name,
      phone: customer.phone
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Seed Products (with stock)
// SAMPLE_PRODUCTS is shared by the manual admin seed endpoint AND the
// automatic startup seed, so demo data only ever gets created once and
// never wipes out real stock/products that already exist.
const SAMPLE_PRODUCTS = [
      // PHONES
      { name: "iPhone 15 Pro Max 256GB", price: 155000, category: "Phones", image: "https://images.unsplash.com/photo-1695048133142-1a20484d2569?w=400", badge: "Official", stock: 8 },
      { name: "Samsung Galaxy S24 Ultra", price: 142000, category: "Phones", image: "https://images.unsplash.com/photo-1610945265064-0e34e5519bbf?w=400", badge: "Top Seller", stock: 12 },
      { name: "Google Pixel 8 Pro", price: 98000, category: "Phones", image: "https://images.unsplash.com/photo-1598327105666-5b89351aff97?w=400", badge: "Best Camera", stock: 7 },
      { name: "OnePlus 12 5G", price: 82000, category: "Phones", image: "https://images.unsplash.com/photo-1565849904461-04a58ad377e0?w=400", badge: "Fast Charge", stock: 15 },
      { name: "Xiaomi 14 Ultra", price: 110000, category: "Phones", image: "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=400", badge: "Leica Lens", stock: 10 },
      // PHONE ACCESSORIES
      { name: "Anker MagSafe Power Bank 10K", price: 4500, category: "Phone Accessories", image: "https://m.media-amazon.com/images/I/61a7Y9HbSaL._SL1500_.jpg", badge: "MagSafe", stock: 20 },
      { name: "Fast Charging 65W GaN Charger", price: 2800, category: "Phone Accessories", image: "https://images.unsplash.com/photo-1583863788434-e58a36330cf0?w=400", badge: "65W Fast", stock: 25 },
      { name: "Ugreen Braided Type-C Cable", price: 850, category: "Phone Accessories", image: "https://images.unsplash.com/photo-1585338107529-13afc5f02586?w=400", badge: "Durable", stock: 30 },
      { name: "Baseus Car Mount Holder", price: 1450, category: "Phone Accessories", image: "https://images.unsplash.com/photo-1586105251261-72a756497a11?w=400", badge: "Magnetic", stock: 18 },
      { name: "Spigen Tough Armor Case", price: 2200, category: "Phone Accessories", image: "https://images.unsplash.com/photo-1601784551446-20c9e07cdbdb?w=400", badge: "Protection", stock: 22 },
      // PC ACCESSORIES
      { name: "Keychron K2 Wireless Keyboard", price: 9200, category: "PC Accessories", image: "https://images.unsplash.com/photo-1587829741301-dc798b83add3?w=400", badge: "RGB Mech", stock: 6 },
      { name: "Logitech MX Master 3S Mouse", price: 11500, category: "PC Accessories", image: "https://images.unsplash.com/photo-1615663245857-ac93bb7c39e7?w=400", badge: "Ergonomic", stock: 9 },
      { name: "Razer BlackShark V2 Headset", price: 7800, category: "PC Accessories", image: "https://images.unsplash.com/photo-1546435770-a3e426bf472b?w=400", badge: "7.1 Surround", stock: 11 },
      { name: "Dell 27-inch 4K Monitor", price: 38500, category: "PC Accessories", image: "https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?w=400", badge: "4K IPS", stock: 5 },
      { name: "Elgato Stream Deck MK.2", price: 16500, category: "PC Accessories", image: "https://images.unsplash.com/photo-1593642632823-8f785ba67e45?w=400", badge: "Streaming", stock: 4 },
      // GADGETS
      { name: "Apple AirPods Pro Gen 2", price: 27500, category: "Gadgets", image: "https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=400", badge: "ANC", stock: 14 },
      { name: "Amazfit GTS 4 Smartwatch", price: 10800, category: "Gadgets", image: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400", badge: "AMOLED", stock: 16 },
      { name: "DJI Mini 3 Pro Drone", price: 89000, category: "Gadgets", image: "https://images.unsplash.com/photo-1527977966376-1c8408f9f108?w=400", badge: "4K Video", stock: 3 },
      { name: "JBL Flip 6 Bluetooth Speaker", price: 12500, category: "Gadgets", image: "https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=400", badge: "Waterproof", stock: 13 },
      { name: "Sony WH-1000XM5 Headphones", price: 36000, category: "Gadgets", image: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400", badge: "High-Res", stock: 7 }
];

// Manual "Seed Products" button in the admin dashboard.
// This is now NON-DESTRUCTIVE: it only inserts the sample items that don't
// already exist (matched by name), so clicking it never wipes real stock
// numbers, real orders, or custom products you've added since going live.
const seedHandler = async (req, res) => {
  try {
    const existingNames = new Set((await Product.find({}, 'name')).map(p => p.name));
    const toInsert = SAMPLE_PRODUCTS.filter(p => !existingNames.has(p.name));
    if (toInsert.length === 0) {
      return res.json({ message: 'Sample products are already in your catalog - nothing to add.', added: 0 });
    }
    await Product.insertMany(toInsert);
    res.json({ message: `${toInsert.length} sample product(s) added (existing products and stock left untouched).`, added: toInsert.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Seeding touches product data, so it's admin-only just like every other
// catalog-modifying endpoint. It used to be wide open to anyone on the
// internet, which meant a stranger could hit it and reset the shop.
app.post('/api/seed', authenticateToken, isAdmin, seedHandler);

// Runs once automatically when the server (re)connects to a fresh/empty
// database, so a brand-new deployment isn't an empty storefront - but it
// never runs again once you have real products, so it can't clobber
// live stock on a restart or redeploy.
async function autoSeedIfEmpty() {
  try {
    const count = await Product.countDocuments();
    if (count === 0) {
      await Product.insertMany(SAMPLE_PRODUCTS);
      console.log('🌱 Database was empty - auto-seeded 20 starter products.');
    }
  } catch (err) {
    console.error('Auto-seed check failed:', err.message);
  }
}

// ==================== CUSTOMER API ENDPOINTS (AUTHENTICATED) ====================

// 6. Get Customer's Orders
app.get('/api/orders/my', authenticateToken, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.user.username });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const orders = await Order.find({ customerId: user._id }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== ADMIN API ENDPOINTS (AUTHENTICATED + ADMIN) ====================

// 7. Admin: Get all orders
app.get('/api/admin/orders', authenticateToken, isAdmin, async (req, res) => {
  try {
    const orders = await Order.find().populate('customerId').sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// 9. Admin: Get all users with order count
app.get('/api/admin/users', authenticateToken, isAdmin, async (req, res) => {
  try {
    // Get all customers
    const users = await User.find({ role: 'customer' }).select('-password');
    
    // For each user, count their orders
    const usersWithOrderCount = await Promise.all(users.map(async (user) => {
      const orderCount = await Order.countDocuments({ customerId: user._id });
      return {
        _id: user._id,
        name: user.name,
        phone: user.phone,
        username: user.username,
        orderCount: orderCount
      };
    }));
    
    res.json(usersWithOrderCount);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// 8. Admin: Update order status
app.put('/api/admin/orders/:id/status', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['Pending', 'In Shipping', 'Delivered'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }
    const order = await Order.findByIdAndUpdate(
      req.params.id, 
      { status }, 
      { new: true }
    );
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Admin: Get all products (with stock)
app.get('/api/admin/products', authenticateToken, isAdmin, async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 11. Admin: Add new product
app.post('/api/admin/products', authenticateToken, isAdmin, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const price = Number(req.body.price);
    const category = req.body.category;
    const image = (req.body.image || '').trim();
    const badge = (req.body.badge || '').trim();
    const stock = req.body.stock === undefined || req.body.stock === '' ? 10 : Number(req.body.stock);

    if (!name || !price || price <= 0 || !category || !image) {
      return res.status(400).json({ error: 'Name, Price, Category, and Image are required.' });
    }
    if (!Number.isInteger(stock) || stock < 0) {
      return res.status(400).json({ error: 'Stock must be a whole number of 0 or more.' });
    }

    const newProduct = new Product({ name, price, category, image, badge, stock });
    await newProduct.save();
    res.status(201).json(newProduct);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12. Admin: Update product stock
app.put('/api/admin/products/:id/stock', authenticateToken, isAdmin, async (req, res) => {
  try {
    const stock = Number(req.body.stock);
    if (!Number.isInteger(stock) || stock < 0) {
      return res.status(400).json({ error: 'Valid, non-negative whole-number stock is required.' });
    }
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { stock },
      { new: true }
    );
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 13. Admin: Get sales summary (grouped by date)
app.get('/api/admin/sales', authenticateToken, isAdmin, async (req, res) => {
  try {
    const sales = await Order.aggregate([
      { 
        $group: { 
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, 
          total: { $sum: '$totalAmount' }, 
          count: { $sum: 1 } 
        } 
      },
      { $sort: { _id: -1 } }
    ]);
    res.json(sales);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 GearBari server running on http://localhost:${PORT}`));