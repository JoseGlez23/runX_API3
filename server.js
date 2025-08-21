require("dotenv").config();
const express = require("express");
const mysql = require("mysql");
const bodyParser = require("body-parser");
const cors = require("cors");
const Stripe = require("stripe");
const bcrypt = require("bcrypt");
const speakeasy = require("speakeasy");
const qrcode = require("qrcode");

const app = express();
const port = process.env.PORT || 3000;
const stripe = Stripe(process.env.STRIPE_SECRET);

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// Conexión MySQL usando variables de entorno
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  connectionLimit: 10,
};

const pool = mysql.createPool(dbConfig);
pool.getConnection((err, connection) => {
  if (err) console.error("❌ Error DB:", err);
  else {
    if (connection) connection.release();
    console.log("✅ Conectado a MySQL");
  }
});
app.use((req, res, next) => {
  req.db = pool;
  next();
});

/* ===========================
   CLIENTES (Registro/Login)
=========================== */
app.post("/api/clientes/register", async (req, res) => {
  const { nombre, email, password } = req.body;
  if (!nombre || !email || !password)
    return res.status(400).json({ message: "Todos los campos son requeridos" });

  const hashed = await bcrypt.hash(password, 10);
  req.db.query(
    "INSERT INTO clientes (nombre,email,password) VALUES (?,?,?)",
    [nombre, email, hashed],
    (err, result) => {
      if (err)
        return res.status(err.code === "ER_DUP_ENTRY" ? 400 : 500).json({
          message:
            err.code === "ER_DUP_ENTRY"
              ? "Email ya registrado"
              : "Error al registrar cliente",
        });
      res
        .status(201)
        .json({ message: "Cliente registrado", id: result.insertId });
    }
  );
});

app.post("/api/clientes/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ message: "Email y password requeridos" });

  req.db.query(
    "SELECT * FROM clientes WHERE email=?",
    [email],
    async (err, results) => {
      if (err) return res.status(500).json({ message: "Error login" });
      if (results.length === 0)
        return res.status(401).json({ message: "Credenciales inválidas" });

      const cliente = results[0];
      const ok = await bcrypt.compare(password, cliente.password);
      if (!ok)
        return res.status(401).json({ message: "Credenciales inválidas" });

      res.json({
        message: "Login exitoso",
        cliente: {
          id: cliente.id,
          nombre: cliente.nombre,
          email: cliente.email,
          twofa_enabled: !!cliente.twofa_secret,
        },
      });
    }
  );
});

/* ===========================
   PRODUCTOS CRUD
=========================== */
app.get("/api/productos", (req, res) =>
  req.db.query("SELECT * FROM productos", (err, results) =>
    err
      ? res.status(500).json({ message: "Error productos" })
      : res.json(results)
  )
);

app.get("/api/productos/:id", (req, res) => {
  req.db.query(
    "SELECT * FROM productos WHERE id=?",
    [req.params.id],
    (err, results) => {
      if (err) return res.status(500).json({ message: "Error" });
      if (results.length === 0)
        return res.status(404).json({ message: "Producto no encontrado" });
      res.json(results[0]);
    }
  );
});

app.post("/api/productos", (req, res) => {
  const { nombre, precio, descripcion, tallas, imagen } = req.body;
  if (!nombre || !precio || !descripcion || !tallas || !imagen)
    return res
      .status(400)
      .json({ message: "Todos los campos son obligatorios" });

  req.db.query(
    "INSERT INTO productos(nombre,precio,descripcion,tallas,imagen) VALUES (?,?,?,?,?)",
    [nombre, parseFloat(precio), descripcion, tallas, imagen],
    (err, result) => {
      if (err)
        return res.status(500).json({ message: "Error al agregar producto" });
      res
        .status(201)
        .json({ message: "Producto agregado", id: result.insertId });
    }
  );
});

app.put("/api/productos/:id", (req, res) => {
  const { nombre, precio, descripcion, tallas, imagen } = req.body;
  req.db.query(
    "UPDATE productos SET nombre=?,precio=?,descripcion=?,tallas=?,imagen=? WHERE id=?",
    [nombre, parseFloat(precio), descripcion, tallas, imagen, req.params.id],
    (err) =>
      err
        ? res.status(500).json({ message: "Error actualizar" })
        : res.json({ message: "Producto actualizado" })
  );
});

app.delete("/api/productos/:id", (req, res) => {
  req.db.query("DELETE FROM productos WHERE id=?", [req.params.id], (err) =>
    err
      ? res.status(500).json({ message: "Error eliminar" })
      : res.json({ message: "Producto eliminado" })
  );
});

/* ===========================
   CARRITO
=========================== */
app.get("/api/carrito/:clienteId", (req, res) => {
  const clienteId = req.params.clienteId;
  const sql = `
    SELECT c.id, p.id AS producto_id, p.nombre, p.precio, p.imagen, c.cantidad, p.tallas 
    FROM carrito c JOIN productos p ON c.producto_id=p.id WHERE c.cliente_id=?`;
  req.db.query(sql, [clienteId], (err, results) =>
    err ? res.status(500).json({ message: "Error carrito" }) : res.json(results)
  );
});

app.post("/api/carrito/:clienteId", (req, res) => {
  const { clienteId } = req.params;
  const { productoId, cantidad } = req.body;
  req.db.query(
    "INSERT INTO carrito(cliente_id,producto_id,cantidad) VALUES (?,?,?)",
    [clienteId, productoId, cantidad || 1],
    (err, result) =>
      err
        ? res.status(500).json({ message: "Error agregar carrito" })
        : res.json({ message: "Agregado", id: result.insertId })
  );
});

app.put("/api/carrito/:clienteId/:id", (req, res) => {
  const { clienteId, id } = req.params;
  const { cantidad } = req.body;
  if (cantidad < 1) return res.status(400).json({ message: "Cantidad >0" });

  req.db.query(
    "UPDATE carrito SET cantidad=? WHERE id=? AND cliente_id=?",
    [cantidad, id, clienteId],
    (err) =>
      err
        ? res.status(500).json({ message: "Error actualizar" })
        : res.json({ message: "Cantidad actualizada" })
  );
});

app.delete("/api/carrito/:clienteId/:id", (req, res) => {
  const { clienteId, id } = req.params;
  req.db.query(
    "DELETE FROM carrito WHERE id=? AND cliente_id=?",
    [id, clienteId],
    (err) =>
      err
        ? res.status(500).json({ message: "Error eliminar" })
        : res.json({ message: "Producto eliminado" })
  );
});

/* ===========================
   2FA (TOTP QR)
=========================== */
app.post("/api/2fa/status", (req, res) => {
  const { clienteId } = req.body;
  req.db.query(
    "SELECT twofa_secret FROM clientes WHERE id=?",
    [clienteId],
    (err, results) => {
      if (err) return res.status(500).json({ message: "Error 2FA" });
      if (results.length === 0)
        return res.status(404).json({ message: "Cliente no encontrado" });
      res.json({ twofa_enabled: !!results[0].twofa_secret });
    }
  );
});

app.post("/api/2fa/setup", async (req, res) => {
  const { clienteId } = req.body;
  req.db.query(
    "SELECT email,twofa_secret FROM clientes WHERE id=?",
    [clienteId],
    async (err, results) => {
      if (err) return res.status(500).json({ message: "Error cliente" });
      if (results.length === 0)
        return res.status(404).json({ message: "Cliente no encontrado" });

      const { email, twofa_secret } = results[0];
      let base32Secret = twofa_secret;

      if (!base32Secret) {
        const generated = speakeasy.generateSecret({
          name: `RunX (${email})`,
          length: 20,
        });
        base32Secret = generated.base32;
        req.db.query("UPDATE clientes SET twofa_secret=? WHERE id=?", [
          base32Secret,
          clienteId,
        ]);
      }

      const otpauth = speakeasy.otpauthURL({
        secret: base32Secret,
        label: `RunX (${email})`,
        issuer: "RunX",
        encoding: "base32",
      });
      const qr = await qrcode.toDataURL(otpauth);
      res.json({ qr, secret: base32Secret });
    }
  );
});

app.post("/api/2fa/verificar", (req, res) => {
  const { clienteId, code } = req.body;
  req.db.query(
    "SELECT twofa_secret FROM clientes WHERE id=?",
    [clienteId],
    (err, results) => {
      if (err) return res.status(500).json({ message: "Error 2FA" });
      if (results.length === 0 || !results[0].twofa_secret)
        return res.status(400).json({ message: "Cliente no tiene 2FA" });

      const verified = speakeasy.totp.verify({
        secret: results[0].twofa_secret,
        encoding: "base32",
        token: code,
        window: 1,
      });
      if (!verified)
        return res.status(400).json({ message: "Código inválido o expirado" });

      res.json({ message: "Código 2FA verificado" });
    }
  );
});

/* ===========================
   PAGO Stripe
=========================== */
app.post("/api/crear-intento-pago", async (req, res) => {
  try {
    const { monto, moneda, clienteId } = req.body;
    if (typeof monto !== "number" || !moneda)
      return res.status(400).json({ error: "monto y moneda requeridos" });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(monto),
      currency: moneda,
      payment_method_types: ["card"],
      metadata: { clienteId: String(clienteId || "") },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===========================
   ORDENES
=========================== */
app.post("/api/ordenes", (req, res) => {
  const { clienteId, total, productos } = req.body;
  if (
    !clienteId ||
    !total ||
    !Array.isArray(productos) ||
    productos.length === 0
  )
    return res.status(400).json({ message: "Datos incompletos" });

  req.db.query(
    "INSERT INTO orders(cliente_id,total) VALUES (?,?)",
    [clienteId, total],
    (err, result) => {
      if (err) return res.status(500).json({ message: "Error crear orden" });

      const ordenId = result.insertId;
      const valores = productos.map((item) => [
        ordenId,
        item.producto_id,
        item.cantidad,
        item.precio,
      ]);

      req.db.query(
        "INSERT INTO order_items(order_id,producto_id,cantidad,precio) VALUES ?",
        [valores],
        (err2) => {
          if (err2)
            return res
              .status(500)
              .json({ message: "Error guardar detalles orden" });

          req.db.query(
            "DELETE FROM carrito WHERE cliente_id=?",
            [clienteId],
            (err3) =>
              err3
                ? res.status(500).json({ message: "Error limpiar carrito" })
                : res.json({ message: "Orden creada", ordenId })
          );
        }
      );
    }
  );
});

/* ===========================
   SERVIDOR
=========================== */
app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${port}`);
});
