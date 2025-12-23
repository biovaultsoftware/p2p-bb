import express from 'express';
import webpush from 'web-push';

const app = express();
app.use(express.json({ limit: '1mb' }));

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error("Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. Run: node gen-vapid.js");
  process.exit(1);
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// In production store in DB/KV by HID.
const subsByHid = new Map();

app.get('/push/vapidPublicKey', (req,res)=> res.json({ publicKey: VAPID_PUBLIC_KEY }));

app.post('/push/subscribe', (req,res)=>{
  const { hid, sub } = req.body || {};
  if (!hid || !sub) return res.status(400).json({ ok:false });
  subsByHid.set(hid, sub);
  res.json({ ok:true });
});

// Send a poke notification (no message content)
app.post('/push/poke', async (req,res)=>{
  const { toHid, fromHid } = req.body || {};
  if (!toHid) return res.status(400).json({ ok:false });
  const sub = subsByHid.get(toHid);
  if (!sub) return res.status(404).json({ ok:false, reason:'no-subscription' });

  const payload = JSON.stringify({
    title: 'New message',
    body: `Pending updates from ${fromHid || 'a contact'}. Open to pull.`,
    peer: fromHid || ''
  });

  try {
    await webpush.sendNotification(sub, payload);
    res.json({ ok:true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error: String(e) });
  }
});

app.listen(8788, ()=> console.log('Push poke server on http://localhost:8788'));
