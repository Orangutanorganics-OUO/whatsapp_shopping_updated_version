// server-whatsapp-payments.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import { google } from 'googleapis';
import ShortUniqueId from 'short-unique-id';

const app = express();

// capture raw body for webhook signature verification if needed
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }));

// --- ENV ---
const {
  PORT = 3000,
  VERIFY_TOKEN,
  ACCESS_TOKEN,
  PHONE_NUMBER_ID,
  PAYMENT_CONFIGURATION_NAME, // NEW - set this to the "name" you created in Meta (e.g. upi_test)
  FLOW_ID,
  DELHIVERY_TOKEN,
  DELHIVERY_CHARGES_TOKEN,
  DELHIVERY_ORIGIN_PIN = '110042',
  DELHIVERY_CHARGES_URL = 'https://track.delhivery.com/api/kinko/v1/invoice/charges/.json',
  DELHIVERY_CREATE_URL = 'https://track.delhivery.com/api/cmu/create.json',
  GOOGLE_SERVICE_ACCOUNT_EMAIL = "logeshe48@gmail.com",
  GOOGLE_PRIVATE_KEY,
  SHEET_ID,

  // Optional: provider/BSP-based payment lookup (set this if your BSP provides a REST lookup)
  PAYMENTS_LOOKUP_BASE_URL,
  PAYMENTS_LOOKUP_API_KEY
} = process.env;

if (!PAYMENT_CONFIGURATION_NAME) {
  console.warn('Warning: PAYMENT_CONFIGURATION_NAME not set. The order_details message requires the exact payment configuration name from Meta.');
}

const GRAPH_URL = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

// --- STATE STORE ---
const orderSessions = {};        // orderId => session
const phoneToOrderIds = {};      // phone => [orderId,...]

// --- Helpers ---
function normalizePhone(phone) { return (phone || '').replace(/\D/g, ""); }

async function sendWhatsAppText(to, text) {
  try {
    await axios.post(GRAPH_URL, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  } catch (err) {
    console.error('sendWhatsAppText error', err.response?.data || err.message || err);
  }
}

async function sendWhatsAppCatalog(to) {
  try {
    await axios.post(GRAPH_URL,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "product_list",
          header: { type: "text", text: "Featured Products 🌟" },
          body: { text: "Browse our catalog and pick your favorites 🌱" },
          footer: { text: "OrangUtan Organics" },
          action: {
            catalog_id: "1262132998945503",
            sections: [
              {
                title: "Our Products",
                product_items: [
                  { product_retailer_id: "43mypu8dye" },
                  { product_retailer_id: "l722c63kq9" },
                  { product_retailer_id: "kkii6r9uvh" },
                  { product_retailer_id: "m519x5gv9s" },
                  { product_retailer_id: "294l11gpcm" },
                  { product_retailer_id: "ezg1lu6edm" },
                  { product_retailer_id: "tzz72lpzz2" },
                  { product_retailer_id: "esltl7pftq" },
                  { product_retailer_id: "obdqyehm1w" }
                ]
              }
            ]
          }
        }
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
  } catch (err) {
    console.error('sendWhatsAppCatalog error', err.response?.data || err.message || err);
  }
}

async function sendWhatsAppFlow(to, flowId, flowToken = null) {
  const data = {
    messaging_product: "whatsapp",
    to: to,
    type: "interactive",
    interactive: {
      type: "flow",
      header: { type: "text", text: "Fill Delivery Details" },
      body: { text: "Please tap below to provide your info securely." },
      footer: { text: "OrangUtan Organics" },
      action: {
        name: "flow",
        parameters: {
          flow_id: flowId,
          flow_message_version: "3",
          flow_cta: "Enter Details"
        }
      }
    }
  };
  if (flowToken) data.interactive.action.parameters.flow_token = flowToken;
  try {
    await axios.post(GRAPH_URL, data, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });
  } catch (err) {
    console.error('sendWhatsAppFlow error', err.response?.data || err.message || err);
  }
}

// --- Google Sheets (keep as before) ---
let sheetsClient = null;
function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    console.warn('Google service account credentials missing - sheet updates will be skipped.');
    return null;
  }
  const auth = new google.auth.GoogleAuth({
    // Note: this sample uses keyFile; if you prefer passing the key via env - change accordingly
    keyFile: "cred.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

async function appendToSheet(rowValues) {
  const sheets = getSheetsClient();
  if (!sheets || !SHEET_ID) return null;
  try {
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [rowValues] }
    });
    return res.data;
  } catch (err) {
    console.error('appendToSheet error', err.response?.data || err.message || err);
    throw err;
  }
}

// product metadata (as you had)
const getProductName =
  { "43mypu8dye":"Himalayan badri cow ghee 120gm" ,
    "l722c63kq9":"Himalayan badri cow ghee 295gm" ,
    "kkii6r9uvh":"Himalayan badri cow ghee 495gm" ,
    "m519x5gv9s":"Himalayan White Rajma 500gm" ,
    "294l11gpcm":"Himalayan White Rajma 1kg" ,
    "ezg1lu6edm":"Himalayan Red Rajma 500gm" ,
    "tzz72lpzz2":"Himalayan Red Rajma 1kg" ,
    "esltl7pftq":"Wild Himalayan Tempering Spice" ,
    "obdqyehm1w":"Himalayan Red Rice"};

const getProductWeight =
  { "43mypu8dye":120 ,
    "l722c63kq9":295 ,
    "kkii6r9uvh":495 ,
    "m519x5gv9s":500 ,
    "294l11gpcm":1000 ,
    "ezg1lu6edm":500 ,
    "tzz72lpzz2":1000 ,
    "esltl7pftq":100 ,
    "obdqyehm1w":1000};

// ---------------- NEW: send order_details (WhatsApp native payment) ----------------
async function sendWhatsAppOrderDetails(to, session) {
  if (!PAYMENT_CONFIGURATION_NAME) {
    console.error("Cannot send order_details: PAYMENT_CONFIGURATION_NAME not configured in env.");
    throw new Error("PAYMENT_CONFIGURATION_NAME missing");
  }

  // Build items for order_details; amounts must be integer * offset (offset=100 for INR)
  const items = (session.productItems || []).map((it) => {
    const retailer_id = it.product_retailer_id || it.retailer_id || it.id || '';
    const name = getProductName[retailer_id] || it.name || 'Item';
    // Prefer item.item_price if present (likely in catalog order payload), assume rupees -> convert to paise
    const unitPricePaise = Math.round((parseFloat(it.item_price || it.price || 0) || 0) * 100) || 0;
    const qty = parseInt(it.quantity || it.qty || it.quantity_ordered || 1, 10) || 1;
    const amountValue = unitPricePaise || Math.round((session.amount || 0) / Math.max(1, (session.productItems || []).length));
    return {
      retailer_id,
      name,
      amount: { value: amountValue, offset: 100 },
      quantity: qty
    };
  });

  // total amount (paise) is session.amount (we keep this convention)
  const prod_cost = session.amount || items.reduce((s, it) => s + (it.amount?.value || 0) * (it.quantity || 1), 0);
  let shippingChargePaise = 0;
  const product_data = session.productItems || [];
   let total_wgt = 0;
    for (let i = 0; i < product_data.length; i++) {
      const id = product_data[i].product_retailer_id;
      const q = parseInt(product_data[i].quantity, 10) || 1;
      total_wgt += ((getProductWeight[id] || 0) * q);
    }
    try {
      const chargesResp = await getDelhiveryCharges({
        origin_pin: DELHIVERY_ORIGIN_PIN,
        dest_pin: session.customer?.pincode || session.customer?.pin || '',
        cgm: total_wgt,
        pt: 'Pre-paid'
      });
      if (chargesResp && Array.isArray(chargesResp) && chargesResp[0]?.total_amount) {
        shippingChargePaise = Math.round(chargesResp[0].total_amount * 100);
      } else if (chargesResp?.total_amount) {
        // sometimes partners return object
        shippingChargePaise = Math.round(chargesResp.total_amount * 100);
      } else {
        console.warn("Could not parse delhivery charges response:", chargesResp);
      }
    } catch (err) {
      console.warn('Error retrieving delhivery charges for prepaid', err.message || err);
    }

    session.shipping_charge = shippingChargePaise;


    const totalAmountValue = prod_cost+shippingChargePaise
  




  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "order_details",
      header: { type: "text", text: `Order ${session.orderId}` },
      body: { text: "Please review your order and complete the payment. NOTE: shipment cost is included" },
      footer: { text: "OrangUtan Organics" },
      action: {
        name: "review_and_pay",
        parameters: {
          reference_id: session.orderId,
          type: "physical-goods",
          currency: "INR",
          total_amount: { value: totalAmountValue, offset: 100 },
          payment_type: "payment_gateway:razorpay", // using UPI payment config; if using gateway use "payment_gateway:razorpay" etc.
          payment_configuration: PAYMENT_CONFIGURATION_NAME,
          order: {
            status: "pending",
            items,
            subtotal: { value: prod_cost, offset: 100 },
            tax: { value: 0, offset: 100 },
            shipping: { value: Math.round((session.shipping_charge || 0)), offset: 100 }
          }
        }
      }
    }
  };

  try {
    const res = await axios.post(GRAPH_URL, payload, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });
    return res.data;
  } catch (err) {
    console.error('sendWhatsAppOrderDetails error', err.response?.data || err.message || err);
    throw err;
  }
}

// ---------------- re-usable finalization of a paid order ----------------
async function finalizePaidOrder(session, paymentInfo = {}) {
  const phone = session.phone || '';
  session.payment_status = 'paid';
  try {
    await sendWhatsAppText(phone, "✅ Payment successful! Your order is confirmed.");

    // compute shipping using Delhivery (same logic you used before)
    let shippingChargePaise = 0;
    const product_data = session.productItems || [];

    let total_wgt = 0;
    for (let i = 0; i < product_data.length; i++) {
      const id = product_data[i].product_retailer_id;
      const q = parseInt(product_data[i].quantity, 10) || 1;
      total_wgt += ((getProductWeight[id] || 0) * q);
    }

    // Build final product description
    let final_product_name = "";
    for (let i = 0; i < product_data.length; i++) {
      final_product_name += (getProductName[product_data[i].product_retailer_id] || 'Item') + "(" + (product_data[i].quantity || 1) + ")" + "\n";
    }
    final_product_name += "+ shipping charge";

    try {
      const chargesResp = await getDelhiveryCharges({
        origin_pin: DELHIVERY_ORIGIN_PIN,
        dest_pin: session.customer?.pincode || session.customer?.pin || '',
        cgm: total_wgt,
        pt: 'Pre-paid'
      });
      if (chargesResp && Array.isArray(chargesResp) && chargesResp[0]?.total_amount) {
        shippingChargePaise = Math.round(chargesResp[0].total_amount * 100);
      } else if (chargesResp?.total_amount) {
        // sometimes partners return object
        shippingChargePaise = Math.round(chargesResp.total_amount * 100);
      } else {
        console.warn("Could not parse delhivery charges response:", chargesResp);
      }
    } catch (err) {
      console.warn('Error retrieving delhivery charges for prepaid', err.message || err);
    }

    session.shipping_charge = shippingChargePaise;

    // Build shipment payload for Delhivery
    const shipment = {
      name: session.customer?.name || 'Customer',
      add: `${session.customer?.address1 || ''} ${session.customer?.address2 || ''}`.trim(),
      pin: session.customer?.pincode || session.customer?.pin || '',
      city: session.customer?.city || '',
      state: session.customer?.state || '',
      country: 'India',
      phone: session.customer?.phone || phone,
      order: `Order_${session.orderId || Date.now()}`,
      payment_mode: "Prepaid",
      products_desc: final_product_name,
      hsn_code: "",
      cod_amount: "0",
      total_amount: String(Math.round(session.amount / 100)), // rupees
      seller_add: "",
      seller_name: "",
      seller_inv: "",
      quantity: "",
      waybill: "",
      shipment_width: "100",
      shipment_height: "100",
      weight: "",
      shipping_mode: "Surface",
      address_type: ""
    };

    let delhiveryResp = null;
    try {
      delhiveryResp = await createDelhiveryShipment({ shipment });
      await sendWhatsAppText(phone, `📦 Shipment created. We'll share tracking once available.`);
    } catch (err) {
      console.error('Delhivery create after payment failed', err.message || err);
      await sendWhatsAppText(phone, `⚠️ Payment received but shipment creation failed. We'll follow up.`);
    }

    // Append final row to sheet marking paid and shipment info
    try {
      const row = [
        new Date().toISOString(),
        session.customer?.name || '',
        session.customer?.phone || phone,
        session.customer?.email || '',
        `${session.customer?.address1 || ''} ${session.customer?.address2 || ''}`.trim(),
        session.customer?.pincode || '',
        JSON.stringify(session.productItems || []),
        'Prepaid',
        'Paid',
        (session.amount / 100).toFixed(2),
        (session.shipping_charge / 100).toFixed(2),
        '0.00',
        JSON.stringify(delhiveryResp || {}),
        session.orderId || ''
      ];
      await appendToSheet(row);
    } catch (err) {
      console.error('Failed to append prepaid paid order to sheet', err);
    }

  } catch (err) {
    console.error("Failed finalizePaidOrder:", err);
  }
}

// ---------------- Delhivery helpers (unchanged) ----------------
async function getDelhiveryCharges({ origin_pin = DELHIVERY_ORIGIN_PIN, dest_pin, cgm = 5000, pt = 'Pre-paid' }) {
  try {
    const params = {
      md: 'S',
      ss: 'Delivered',
      d_pin: dest_pin,
      o_pin: origin_pin,
      cgm,
      pt
    };
    const res = await axios.get(DELHIVERY_CHARGES_URL, {
      headers: { Authorization: `Token ${DELHIVERY_CHARGES_TOKEN || DELHIVERY_TOKEN}`, 'Content-Type': 'application/json' },
      params
    });
    return res.data;
  } catch (err) {
    console.error('Delhivery charges error', err.response?.data || err.message || err);
    throw err;
  }
}

async function createDelhiveryShipment({ shipment, pickup_location = { name: "Delhivery Uttarkashi", add: "", city: "", pin: DELHIVERY_ORIGIN_PIN, phone: "" } }) {
  try {
    const payload = { shipments: [shipment], pickup_location };
    const bodyStr = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`;
    const res = await axios.post(DELHIVERY_CREATE_URL, bodyStr, {
      headers: {
        Accept: 'application/json',
        Authorization: `Token ${DELHIVERY_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    return res.data;
  } catch (err) {
    console.error('Delhivery create error', err.response?.data || err.message || err);
    throw err;
  }
}

// ---------------- Webhook & message handlers (main) ----------------

// Webhook verification (Meta webhook)
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log("webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Incoming WhatsApp messages
app.post('/', async (req, res) => {
  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return res.sendStatus(200);

  const fromRaw = msg.from;
  const from = normalizePhone(fromRaw);
  if (!phoneToOrderIds[from]) phoneToOrderIds[from] = [];

  let session = null;
  let msgBody = "";
  if (msg.type === "text") {
    msgBody = msg.text?.body?.trim() || "";
  } else if (msg.type === "interactive") {
    if (msg.interactive.type === "button_reply") {
      msgBody = msg.interactive.button_reply.title?.trim() || "";
    } else if (msg.interactive.type === "list_reply") {
      msgBody = msg.interactive.list_reply.title?.trim() || "";
    }
  } else if (msg.type === "order") {
    msgBody = "order_received";
  }

  // Flow submission handler (nfm_reply)
  if (msg?.interactive?.nfm_reply) {
    let customerData;
    try {
      customerData = JSON.parse(msg.interactive.nfm_reply.response_json);
    } catch (e) {
      customerData = msg.interactive.nfm_reply.response_json;
    }
    if (customerData?.flow_token === 'test_101') {
      console.log('Ignoring meta test flow payload');
      return res.sendStatus(200);
    }

    
    const uid = new ShortUniqueId({ length: 5, dictionary: 'number' });
    const orderId = `OUO-${uid.randomUUID()}`;
    // const orderId = uuidv4().slice(0,34);
    session = {
      orderId,
      phone: from,
      customer: customerData,
      step: 4,
      productItems: (orderSessions[from]?.productItems) || [],
      amount: (orderSessions[from]?.amount) || 0
    };
    orderSessions[orderId] = session;
    phoneToOrderIds[from].push(orderId);

    await sendWhatsAppText(from, `Thanks! We've received your delivery details. (OrderId: ${orderId})`);

    session.amount = session.amount || 0; // paise
    const paymentMode = (customerData.payment_mode || '').toLowerCase();
    console.log("paymentMode:", paymentMode);

    if (paymentMode === 'cod' || paymentMode === 'cash on delivery' || paymentMode === 'cash-on-delivery') {
      // handle COD path (you can reuse your existing COD flow)
      session.cod_error = true;
            const codChargePaise = 150 * 100;
            let shippingChargePaise = 0;
      
            //total weight of products
            const product_data = session.productItems;
            let total_wgt = 0
            for(let i=0;i<product_data.length;i++){
                // console.log(getProductWeight[a[i].product_retailer_id], a[i].quantity);
                total_wgt+=getProductWeight[product_data[i].product_retailer_id]*product_data[i].quantity
            }
      
            let final_product_name = "";
            for(let i=0;i<product_data.length;i++){
                // console.log(i);
                final_product_name+=getProductName[product_data[i].product_retailer_id]+"("+product_data[i].quantity+")"+"\n";  
            }
            final_product_name+="+ COD charge 150 + shipping charge"
      
            // console.log("outsideee******** ",final_product_name);
            
      
      
      
            console.log("totalllll ***************** = ", total_wgt);
            
      
            
            
            try {
              // call Delhivery charges: cgm = 5000 (per your note)
              const chargesResp = await getDelhiveryCharges({
                origin_pin: DELHIVERY_ORIGIN_PIN,
                dest_pin: customerData.pincode || customerData.pin || '',
                cgm: total_wgt,
                pt: 'COD' // set pt based on COD; if Delhivery expects 'Pre-paid' for their price table, change accordingly
              });
              // Attempt to parse charge from response; structure differs by API version
              // We'll try a few keys, but if not present we'll fall back to 0 and continue.
              if (chargesResp) {
                // Example potential fields: chargesResp.charge, chargesResp.data.charge, chargesResp.result.charges etc.
                // We'll search for any numeric value in object properties named 'total' 'total_charge' 'charge' etc.
                // let possible = JSON.stringify(chargesResp);
                // console.log("test------>",possible);
                // console.log();
                
                // console.log("test------>",chargesResp.total_amount);
                // console.log("test------>",chargesResp[0].total_amount);   //this works
                
                const match = chargesResp[0].total_amount;
                console.log("----------> ", typeof match);
                
                if (match) {
                  // assume value in rupees if decimal or integer -> convert to paise
                  shippingChargePaise = Math.round(match * 100);
                } else {
                    session.cod_error = false;
                    console.warn('Could not reliably parse Delhivery charges response, defaulting shipping to 0. Response:', chargesResp);
                }
              }
            } catch (err) {
              session.cod_error = false;
              console.warn('Failed to get Delhivery charges, continuing with shippingChargePaise=0', err.message || err);
            }
            // console.log("ship_cost=",shippingChargePai
            
            session.amount = (session.amount || 0) + codChargePaise + shippingChargePaise;
            session.payment_mode = 'COD';
            session.shipping_charge = shippingChargePaise;
            // session.cod_amount = codChargePaise;
      
            // Build shipment object for Delhivery create.json
            // console.log("insideeeee******** ",final_product_name);
            const shipment = {
              name: customerData.name || 'Customer',
              add: `${customerData.address1 || ''} ${customerData.address2 || ''}`.trim(),
              pin: customerData.pincode || customerData.pin || '',
              city: "",
              state: "",
              country: 'India',
              phone: customerData.phone || from,
              order: `Order_${session.orderId || Date.now()}`,
              payment_mode: "COD",
              return_pin: "",
              return_city: "",
              return_phone: "",
              return_add: "",
              return_state: "",
              return_country: "",
              products_desc: final_product_name,
              hsn_code: "",
              cod_amount: String(Math.round(session.amount / 100)), // rupees
              order_date: null,
              total_amount: String(Math.round(session.amount / 100)), // rupees
              seller_add: "",
              seller_name: "",
              seller_inv: "",
              quantity: "",
              waybill: "",
              shipment_width: "",
              shipment_height: "",
              weight: total_wgt, // optional
              shipping_mode: "Surface",
              address_type: ""
            };
      
            let delhiveryResp = null;
            delhiveryResp = await createDelhiveryShipment({ shipment });
            if(delhiveryResp.success && session.cod_error){
              // Append to Google Sheet
            try {
              const row = [
                new Date().toISOString(),
                customerData.name || '',
                customerData.phone || from,
                customerData.email || '',
                `${customerData.address1 || ''} ${customerData.address2 || ''}`.trim(),
                customerData.pincode || '',
                JSON.stringify(session.productItems || []),
                'COD',
                'Pending', // payment status for COD
                (session.amount / 100).toFixed(2), // amount in rupees
                (session.shipping_charge / 100).toFixed(2),
                (codChargePaise / 100).toFixed(2),
                JSON.stringify(delhiveryResp || {})
              ];
              await appendToSheet(row);
            } catch (err) {
              console.error('Failed to append COD order to sheet', err);
            }
      
            await sendWhatsAppText(from, `✅ Your COD order is placed. Total: ₹${(session.amount/100).toFixed(2)}. We'll notify you when it's shipped.`);
            }
            else{
              await sendWhatsAppText(from, `✅ Data you enter in flow is incorrect, Make sure you enter vaid data`);
            }
      
      
      
            //---------------------------------------Changes logesh-----------------------------------
            // try {
            //   delhiveryResp = await createDelhiveryShipment({ shipment });
            //   // console.log("shipping things:  ", delhiveryResp);
            //   // console.log("shipping things1:  ",typeof delhiveryResp);
            //   console.log("shipping things2:  ", delhiveryResp.packages[0].remarks);
            //   // console.log("shipping things2:  ", delhiveryResp.packages[0].remarks);
      
              
            // } catch (err) {
            //   console.error('Delhivery shipment create failed for COD', err.message || err);
            // }
      
            // // Append to Google Sheet
            // try {
            //   const row = [
            //     new Date().toISOString(),
            //     customerData.name || '',
            //     customerData.phone || from,
            //     customerData.email || '',
            //     `${customerData.address1 || ''} ${customerData.address2 || ''}`.trim(),
            //     customerData.pincode || '',
            //     JSON.stringify(session.productItems || []),
            //     'COD',
            //     'Pending', // payment status for COD
            //     (session.amount / 100).toFixed(2), // amount in rupees
            //     (session.shipping_charge / 100).toFixed(2),
            //     (codChargePaise / 100).toFixed(2),
            //     JSON.stringify(delhiveryResp || {})
            //   ];
            //   await appendToSheet(row);
            // } catch (err) {
            //   console.error('Failed to append COD order to sheet', err);
            // }
      
            // await sendWhatsAppText(from, `✅ Your COD order is placed. Total: ₹${(session.amount/100).toFixed(2)}. We'll notify you when it's shipped.`);
      
            // finalize
            console.log("cod donee");
            
            return res.sendStatus(200);
    } else {
      // PREPAID: use WhatsApp order_details (native payments)
      session.payment_mode = 'Prepaid';
      try {
        // attach phone/email to session.customer
        const customerPayload = {
          phone: customerData.phone || from,
          email: customerData.email,
          name: customerData.name
        };

        // send order_details message which triggers the Review & Pay UI in WhatsApp
        await sendWhatsAppOrderDetails(from, session);

        // optionally also send a textual confirmation
        await sendWhatsAppText(from, `💳 Please tap *Review and Pay* inside the order card above to complete payment. OrderId: ${session.orderId}`);

        // Append preliminary row to sheet (awaiting payment)
        try {
          const row = [
            new Date().toISOString(),
            customerData.name || '',
            customerData.phone || from,
            customerData.email || '',
            `${customerData.address1 || ''} ${customerData.address2 || ''}`.trim(),
            customerData.pincode || '',
            JSON.stringify(session.productItems || []),
            'Prepaid',
            'Awaiting Payment',
            (session.amount / 100).toFixed(2),
            '', // shipping charge unknown yet
            '', // cod amount
            `whatsapp_payment_config:${PAYMENT_CONFIGURATION_NAME}`,
            session.orderId
          ];
          await appendToSheet(row);
        } catch (err) {
          console.error('Failed to append awaiting payment row to sheet', err);
        }

      } catch (err) {
        console.error('Failed to send order_details message', err.response?.data || err.message || err);
        await sendWhatsAppText(from, `⚠️ Could not initiate payment. Please try again later.`);
      }

      return res.sendStatus(200);
    }
  } // end flow handler

  // normal message handlers (unchanged)
  try {
    if (/^(hi|hello)$/i.test(msgBody)) {
      await sendWhatsAppText(from, "Namaste 🌱 Welcome to OrangUtan Organics! Type 'place order' to see our catalog.");
    } else if (/place order/i.test(msgBody)) {
      await sendWhatsAppCatalog(from);
      if (!orderSessions[from]) orderSessions[from] = {};
      orderSessions[from].productItems = orderSessions[from].productItems || [];
      orderSessions[from].amount = orderSessions[from].amount || 0;
      await sendWhatsAppText(from, "Please select items from our catalog.");
    } else if (msg.type === "order" || msgBody === "order_received") {
      const phoneKeySession = orderSessions[from] || {};
      phoneKeySession.catalogId = msg.order?.catalog_id;
      phoneKeySession.productItems = msg.order?.product_items || [];

      let totalAmount = 0;
      for (const item of phoneKeySession.productItems) {
        const priceRupees = parseFloat(item.item_price) || 0;
        const qty = parseInt(item.quantity, 10) || 1;
        totalAmount += priceRupees * 100 * qty;
      }
      phoneKeySession.amount = totalAmount; // in paise
      orderSessions[from] = phoneKeySession;

      // Send Flow for delivery info
      await sendWhatsAppFlow(from, FLOW_ID);
      await sendWhatsAppText(from, "Please tap the button above and provide your delivery details.");
    } else {
      await sendWhatsAppText(from, "Sorry, I didn’t understand that. Type *hi* to get started.");
    }
  } catch (err) {
    console.error("Handler error:", err.response?.data || err);
  }

  res.sendStatus(200);
});

// ---------------- A generic payments webhook endpoint (you must configure your BSP/payment gateway to POST here) ----------------
app.post('/payments-webhook', async (req, res) => {
  const body = req.body;
  const event = body.event;

  const payment = req.body.payload.payment?.entity;
  const payment_link = req.body.payload.payment_link?.entity;
  // console.log("-----payment-------->", payment);
  // console.log("-----pay_contact------>",payment.contact);
  
  

  // fallback: use order_id directly (not ideal if you rely only on reference_id)
  const referenceId = payment_link?.reference_id || payment?.reference_id || payment?.notes?.orderId || null;

  const status = event?.toLowerCase() || '';

  if (!referenceId) {
    console.warn('payments-webhook: could not find reference id in provider payload', body);
    // return res.sendStatus(400);
  }

  console.log('payments-webhook receive:', referenceId, status);

  // const session = orderSessions[referenceId] || null;


  let session = null;
  if (referenceId && orderSessions[referenceId]) {
    session = orderSessions[referenceId];
  } else {
    // fallback: attempt to find session by phone in webhook payload
    let phone = "";
    if (payment) {
      phone = normalizePhone(payment.contact);
    }
    if (!phone && payment_link?.customer?.contact) phone = normalizePhone(payment_link.customer.contact);
    if (phone && phoneToOrderIds[phone] && phoneToOrderIds[phone].length) {
      const lastOrderId = phoneToOrderIds[phone][phoneToOrderIds[phone].length - 1];
      session = orderSessions[lastOrderId];
      console.warn("Fallback session found via phone mapping. orderId:", lastOrderId);
    }
  }
  if (!session) {
    console.warn('payments-webhook: no session for reference id', referenceId);
    return res.sendStatus(200);
  }

  if (status.includes('paid')) {
    try {
      await finalizePaidOrder(session, body);
    } catch (err) {
      console.error('finalizePaidOrder error', err);
    }
  } else if (status.includes('failed') || status.includes('cancel') || status.includes('expired')) {
    session.payment_status = 'failed';
    await sendWhatsAppText(session.phone, "⚠️ Your payment failed or expired. Please try placing the order again.");
  }

  res.sendStatus(200);
});


// ---------------- Start ----------------
app.listen(PORT, () => console.log(`Bot running on :${PORT}`));
