import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import pg from 'pg';
import argon2 from 'argon2';
import { fileTypeFromFile } from 'file-type';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, rename } from 'node:fs/promises';
import path from 'node:path';

const app = express();
const http = createServer(app);
const io = new Server(http, { maxHttpBufferSize: 100_000, cors: false });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgres://localhost/silope_chat' });
const dataDir = process.env.DATA_DIR || path.resolve('data');
const uploadDir = path.join(dataDir, 'uploads');
const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
const production = process.env.NODE_ENV === 'production';
const cookieName = production ? '__Host-silope_chat' : 'silope_chat';
const defaults = { appName: 'SILOPE Chat', logoUrl: 'https://szr.hk/public/images/logos/silope-logo5.png', showLogo: true, logoHeight: 38, logoMode: 'original', theme: 'light', primaryColor: '#560c30' };
const allowedMimes = new Set(['image/jpeg','image/png','image/webp','image/gif','audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav','application/pdf','text/plain','application/zip','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req,res,next)).catch(next);
const validName = v => typeof v === 'string' && /^[a-zA-Z0-9_.-]{3,32}$/.test(v);
const validPassword = v => typeof v === 'string' && v.length >= 12 && v.length <= 200;
const safeEqual = (a,b) => { const x=Buffer.from(a||''), y=Buffer.from(b||''); return x.length===y.length && timingSafeEqual(x,y); };
const hashToken = token => createHash('sha256').update(token).digest('hex');
const cookies = str => Object.fromEntries((str||'').split(';').map(s=>{const p=s.trim().indexOf('=');return p<0?[]:[s.trim().slice(0,p),s.trim().slice(p+1)];}).filter(x=>x.length===2));
const newToken = () => randomBytes(32).toString('base64url');
let setupToken = '';

await mkdir(uploadDir, { recursive: true });
await pool.query(`CREATE TABLE IF NOT EXISTS settings (id int PRIMARY KEY CHECK(id=1), value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, username varchar(32) UNIQUE NOT NULL, password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('admin','user')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id uuid PRIMARY KEY, sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind text NOT NULL CHECK(kind IN ('text','image','audio','file')), body text NOT NULL DEFAULT '', file_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS messages_pair ON messages(sender_id,recipient_id,created_at DESC);
CREATE TABLE IF NOT EXISTS files (id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, stored_name text UNIQUE NOT NULL, original_name text NOT NULL, mime text NOT NULL, size_bytes int NOT NULL, created_at timestamptz NOT NULL DEFAULT now());`);
const installed = async () => (await pool.query('SELECT 1 FROM settings WHERE id=1')).rowCount > 0;
if (!await installed()) {
  try { setupToken = (await readFile(path.join(dataDir,'setup-token'), 'utf8')).trim(); }
  catch { setupToken = newToken(); await writeFile(path.join(dataDir,'setup-token'), setupToken, { mode: 0o600, flag: 'wx' }).catch(async () => {setupToken=(await readFile(path.join(dataDir,'setup-token'),'utf8')).trim();}); }
  console.log('First-run setup token (enter at /install):', setupToken);
}

app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc:["'self'"], scriptSrc:["'self'"], styleSrc:["'self'"], imgSrc:["'self'",'data:','https:'], mediaSrc:["'self'",'blob:'], connectSrc:["'self'",'wss:','https:'], fontSrc:["'self'",'https://szr.hk'], objectSrc:["'none'"], frameAncestors:["'none'"] } } }));
app.use(express.json({ limit: '128kb' }));
app.use('/assets', express.static(path.resolve('public'), { index: false, maxAge: '1h' }));
app.use('/api', (req,res,next) => { if (['POST','PATCH','PUT','DELETE'].includes(req.method) && req.get('origin') !== origin) return res.status(403).json({error:'Invalid origin'}); next(); });
const authenticate = async token => {
  if (!token) return null;
  const q=await pool.query('SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()', [hashToken(token)]);
  return q.rows[0] || null;
};
app.use('/api', asyncRoute(async(req,res,next) => {req.user=await authenticate(cookies(req.headers.cookie)[cookieName]);next();}));
const auth=(req,res,next)=>req.user?next():res.status(401).json({error:'Please sign in'});
const admin=(req,res,next)=>req.user?.role==='admin'?next():res.status(403).json({error:'Administrator access required'});
const limited=rateLimit({windowMs:15*60*1000,limit:12,standardHeaders:'draft-8',legacyHeaders:false});
const shapeUser=u=>({id:u.id,username:u.username,role:u.role,createdAt:u.created_at});
const publicSettings=async()=> (await pool.query('SELECT value FROM settings WHERE id=1')).rows[0]?.value ?? null;
app.get('/api/bootstrap',asyncRoute(async(req,res)=>{const settings=await publicSettings();res.json({installed:!!settings,settings,user:req.user||null,iceServers:JSON.parse(process.env.ICE_SERVERS||'[]')});}));
app.post('/api/install',limited,asyncRoute(async(req,res)=>{
  if (!safeEqual(req.body.setupToken,setupToken) || !setupToken) fail(403,'Invalid setup token');
  const chosen = sanitizeSettings(req.body.settings,defaults);
  const password=newToken();
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO settings(id,value) VALUES(1,$1)',[chosen]);
    await client.query('INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)',[randomUUID(),'admin',await argon2.hash(password),'admin']);
    await client.query('COMMIT');
  } catch(e) {await client.query('ROLLBACK');if(e.code==='23505') fail(409,'Already installed');throw e;} finally {client.release();}
  setupToken='';
  await unlink(path.join(dataDir,'setup-token')).catch(()=>{});
  res.status(201).json({username:'admin',password});
}));
app.post('/api/login',limited,asyncRoute(async(req,res)=>{
  const u=(await pool.query('SELECT * FROM users WHERE username=$1',[String(req.body.username||'')])).rows[0];
  if (!u || typeof req.body.password !== 'string' || !await argon2.verify(u.password_hash,req.body.password)) fail(401,'Invalid username or password');
  const token=newToken();
  await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')",[hashToken(token),u.id]);
  res.cookie(cookieName,token,{httpOnly:true,secure:production,sameSite:'lax',path:'/',maxAge:30*86400*1000});
  res.json({user:shapeUser(u)});
}));
app.post('/api/logout',auth,asyncRoute(async(req,res)=>{await pool.query('DELETE FROM sessions WHERE token_hash=$1',[hashToken(cookies(req.headers.cookie)[cookieName])]);res.clearCookie(cookieName,{path:'/',secure:production,sameSite:'lax'});res.json({ok:true});}));
app.get('/api/users',auth,asyncRoute(async(req,res)=>{const q=await pool.query('SELECT id,username,role,created_at FROM users ORDER BY lower(username)');res.json(q.rows.map(shapeUser));}));
app.post('/api/users',auth,admin,asyncRoute(async(req,res)=>{
  const {username,password}=req.body;
  if(!validName(username)||!validPassword(password)) fail(400,'Username: 3–32 letters, numbers, _ . -; password: 12–200 characters');
  const u=(await pool.query('INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,username,role,created_at',[randomUUID(),username,await argon2.hash(password),'user'])).rows[0];
  io.emit('directory:changed');res.status(201).json(shapeUser(u));
}));
app.patch('/api/users/:id',auth,admin,asyncRoute(async(req,res)=>{
  const {username,password}=req.body;
  if(username===undefined&&password===undefined) fail(400,'No changes');
  if(username!==undefined&&!validName(username)) fail(400,'Invalid username');
  if(password!==undefined&&!validPassword(password)) fail(400,'Password needs at least 12 characters');
  const u=(await pool.query('SELECT id FROM users WHERE id=$1',[req.params.id])).rows[0];if(!u) fail(404,'User not found');
  const updated=(await pool.query('UPDATE users SET username=COALESCE($2,username),password_hash=COALESCE($3,password_hash) WHERE id=$1 RETURNING id,username,role,created_at',[u.id,username??null,password===undefined?null:await argon2.hash(password)])).rows[0];
  if(password!==undefined){await pool.query('DELETE FROM sessions WHERE user_id=$1',[u.id]);io.in(`user:${u.id}`).disconnectSockets(true);}
  io.emit('directory:changed');res.json(shapeUser(updated));
}));
app.delete('/api/users/:id',auth,admin,asyncRoute(async(req,res)=>{
  if(req.params.id===req.user.id) fail(400,'You cannot delete your current administrator account');
  const u=(await pool.query('SELECT role FROM users WHERE id=$1',[req.params.id])).rows[0];if(!u) fail(404,'User not found');
  if(u.role==='admin') fail(400,'Administrator account cannot be deleted');
  io.in(`user:${req.params.id}`).disconnectSockets(true);
  await pool.query('DELETE FROM users WHERE id=$1',[req.params.id]);
  io.emit('directory:changed');res.json({ok:true});
}));
function sanitizeSettings(raw={},prev=defaults){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)) fail(400,'Invalid settings');
  const next={...prev};
  if(raw.appName!==undefined){if(typeof raw.appName!=='string'||raw.appName.length<1||raw.appName.length>60)fail(400,'Invalid title');next.appName=raw.appName;}
  if(raw.logoUrl!==undefined){if(typeof raw.logoUrl!=='string'||raw.logoUrl.length>400||!(raw.logoUrl.startsWith('https://')||raw.logoUrl==='')) fail(400,'Use an HTTPS logo URL');next.logoUrl=raw.logoUrl;}
  if(raw.showLogo!==undefined){if(typeof raw.showLogo!=='boolean')fail(400,'Invalid logo visibility');next.showLogo=raw.showLogo;}
  if(raw.logoHeight!==undefined){if(!Number.isInteger(raw.logoHeight)||raw.logoHeight<20||raw.logoHeight>65)fail(400,'Logo height must be 20–65');next.logoHeight=raw.logoHeight;}
  if(raw.logoMode!==undefined){if(!['original','white','dark'].includes(raw.logoMode))fail(400,'Invalid logo mode');next.logoMode=raw.logoMode;}
  if(raw.theme!==undefined){if(!['light','dark'].includes(raw.theme))fail(400,'Invalid theme');next.theme=raw.theme;}
  if(raw.primaryColor!==undefined){if(!/^#[0-9a-fA-F]{6}$/.test(raw.primaryColor))fail(400,'Invalid color');next.primaryColor=raw.primaryColor;}
  return next;
}
app.put('/api/settings',auth,admin,asyncRoute(async(req,res)=>{const next=sanitizeSettings(req.body,await publicSettings());await pool.query('UPDATE settings SET value=$1 WHERE id=1',[next]);io.emit('settings:changed',next);res.json(next);}));
const upload=multer({dest:uploadDir,limits:{fileSize:25*1024*1024,files:1}});
app.post('/api/files',auth,upload.single('file'),asyncRoute(async(req,res)=>{
  if(!req.file) fail(400,'Choose a file');
  try {
    const detected=await fileTypeFromFile(req.file.path);
    let mime=detected?.mime || (req.file.mimetype==='text/plain'?'text/plain':null);
    if(req.file.mimetype==='audio/webm'&&mime==='video/webm')mime='audio/webm';
    if(req.file.mimetype==='audio/mp4'&&mime==='video/mp4')mime='audio/mp4';
    if(req.file.mimetype==='audio/ogg'&&mime?.startsWith('audio/ogg'))mime='audio/ogg';
    if(!mime||!allowedMimes.has(mime)) fail(415,'Unsupported file type');
    const id=randomUUID(), stored=randomUUID();
    await rename(req.file.path,path.join(uploadDir,stored));
    const name=path.basename(Buffer.from(req.file.originalname,'latin1').toString('utf8')).slice(0,160).replace(/[\r\n"\\/]/g,'_')||'file';
    const f=(await pool.query('INSERT INTO files(id,owner_id,stored_name,original_name,mime,size_bytes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,original_name,mime,size_bytes',[id,req.user.id,stored,name,mime,req.file.size])).rows[0];
    res.status(201).json({id:f.id,name:f.original_name,mime:f.mime,size:f.size_bytes});
  } catch(e){await unlink(req.file.path).catch(()=>{});throw e;}
}));
app.get('/api/files/:id',auth,asyncRoute(async(req,res)=>{
  const f=(await pool.query('SELECT * FROM files WHERE id=$1',[req.params.id])).rows[0];if(!f)fail(404,'File not found');
  const permitted=f.owner_id===req.user.id || (await pool.query('SELECT 1 FROM messages WHERE file_id=$1 AND (sender_id=$2 OR recipient_id=$2)',[f.id,req.user.id])).rowCount>0;
  if(!permitted)fail(403,'Access denied');
  res.set('X-Content-Type-Options','nosniff');res.set('Cache-Control','private, no-store');
  res.type(f.mime);
  res.set('Content-Disposition',`${f.mime.startsWith('image/')||f.mime.startsWith('audio/')?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
  res.sendFile(path.join(uploadDir,f.stored_name));
}));
const messageView=m=>({id:m.id,senderId:m.sender_id,recipientId:m.recipient_id,kind:m.kind,body:m.body,fileId:m.file_id,createdAt:m.created_at});
app.get('/api/messages/:peer',auth,asyncRoute(async(req,res)=>{
  const exists=await pool.query('SELECT 1 FROM users WHERE id=$1',[req.params.peer]);if(!exists.rowCount)fail(404,'User not found');
  const limit=Number(req.query.before)?new Date(Number(req.query.before)):new Date();
  if(Number.isNaN(limit.getTime()))fail(400,'Invalid cursor');
  const q=await pool.query('SELECT * FROM messages WHERE ((sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1)) AND created_at<$3 ORDER BY created_at DESC LIMIT 50',[req.user.id,req.params.peer,limit]);
  res.json(q.rows.reverse().map(messageView));
}));

io.use(async(socket,next)=>{try{
  if(socket.handshake.headers.origin!==origin)throw Error('Invalid origin');
  const user=await authenticate(cookies(socket.handshake.headers.cookie)[cookieName]);if(!user)throw Error('Unauthorized');
  socket.user=user;next();
}catch(e){next(e);}});
io.on('connection',socket=>{
  const uid=socket.user.id;
  socket.join(`user:${uid}`);
  socket.on('message:send',async(payload,ack=()=>{})=>{try{
    if(!payload||typeof payload!=='object')fail(400,'Invalid message');
    const peer=String(payload.recipientId||'');
    if(peer===uid)fail(400,'Select another user');
    if(!(await pool.query('SELECT 1 FROM users WHERE id=$1',[peer])).rowCount)fail(404,'Recipient not found');
    const kind=String(payload.kind||'text');
    if(!['text','image','audio','file'].includes(kind))fail(400,'Invalid message kind');
    const body=String(payload.body||'').trim();
    if(body.length>4000||kind==='text'&&!body)fail(400,'Message must contain 1–4000 characters');
    let fileId=null;
    if(kind!=='text'){
      fileId=String(payload.fileId||'');
      const f=(await pool.query('SELECT mime FROM files WHERE id=$1 AND owner_id=$2',[fileId,uid])).rows[0];
      if(!f||kind==='image'&&!f.mime.startsWith('image/')||kind==='audio'&&!f.mime.startsWith('audio/')||kind==='file'&&(f.mime.startsWith('image/')||f.mime.startsWith('audio/')))fail(400,'Invalid attachment');
    }
    const m=(await pool.query('INSERT INTO messages(id,sender_id,recipient_id,kind,body,file_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[randomUUID(),uid,peer,kind,body,fileId])).rows[0];
    const view=messageView(m);io.to(`user:${uid}`).to(`user:${peer}`).emit('message:new',view);ack({ok:true,message:view});
  }catch(e){ack({ok:false,error:e.message});}});
  for(const event of ['call:offer','call:answer','call:ice','call:end','call:decline'])socket.on(event,async(p={},ack=()=>{})=>{try{
    const peer=String(p.to||'');if(peer===uid||!(await pool.query('SELECT 1 FROM users WHERE id=$1',[peer])).rowCount)fail(400,'Invalid recipient');
    if(event==='call:offer'&&(!['audio','video'].includes(p.mode)||!p.sdp))fail(400,'Invalid offer');
    io.to(`user:${peer}`).emit(event,{from:uid,mode:p.mode,sdp:p.sdp,candidate:p.candidate});ack({ok:true});
  }catch(e){ack({ok:false,error:e.message});}});
});
app.get(/.*/,(req,res)=>res.sendFile(path.resolve('public/index.html')));
app.use((err,req,res,next)=>{
  if(err instanceof multer.MulterError)return res.status(413).json({error:'File too large (25 MB maximum)'});
  if(err.code==='23505')return res.status(409).json({error:'Username already exists'});
  if(err.code==='22P02')return res.status(400).json({error:'Invalid identifier'});
  console.error(err);
  res.status(err.status||500).json({error:err.status?err.message:'Server error'});
});
http.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('SILOPE Chat listening on port',Number(process.env.PORT)||3000));
