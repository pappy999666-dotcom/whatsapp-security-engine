'use strict';
const crypto=require('crypto');
const cookie=require('cookie');
const signature=require('cookie-signature');
const store=require('./webDashboardStore');
const COOKIE='pappy_web_session';
const required=['DATABASE_URL','GITHUB_CLIENT_ID','GITHUB_CLIENT_SECRET','NEON_AUTH_COOKIE_SECRET'];
const setup=()=>({ready:required.every(k=>process.env[k])&&(process.env.NEON_AUTH_COOKIE_SECRET||'').length>=32,missing:required.filter(k=>!process.env[k])});
function base(req){return process.env.PAPPY_WEB_URL||`${req.protocol}://${req.get('host')}`;}
function setSession(res,userId){const payload=Buffer.from(JSON.stringify({sub:userId,exp:Date.now()+604800000})).toString('base64url');const value='s:'+signature.sign(payload,process.env.NEON_AUTH_COOKIE_SECRET);res.setHeader('Set-Cookie',cookie.serialize(COOKIE,value,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:604800}));}
function clearSession(res){res.setHeader('Set-Cookie',cookie.serialize(COOKIE,'',{httpOnly:true,path:'/',maxAge:0}));}
async function current(req){if(!setup().ready)return null;try{const raw=cookie.parse(req.headers.cookie||'')[COOKIE];if(!raw?.startsWith('s:'))return null;const payload=signature.unsign(raw.slice(2),process.env.NEON_AUTH_COOKIE_SECRET);if(!payload)return null;const data=JSON.parse(Buffer.from(payload,'base64url'));return data.exp>Date.now()?store.getUser(data.sub):null;}catch{return null;}}
function requireUser(req,res,next){current(req).then(user=>{if(!user)return res.status(401).json({error:'Authentication required'});req.webUser=user;next();}).catch(next);}
function install(app){
 app.get('/api/auth/status',async(req,res)=>res.json({...setup(),authenticated:Boolean(await current(req))}));
 app.get('/auth/github',(req,res)=>{if(!setup().ready)return res.redirect('/?setup=required');const state=crypto.randomBytes(18).toString('hex');res.setHeader('Set-Cookie',cookie.serialize('pappy_oauth_state',state,{httpOnly:true,sameSite:'lax',path:'/',maxAge:600}));res.redirect(`https://github.com/login/oauth/authorize?${new URLSearchParams({client_id:process.env.GITHUB_CLIENT_ID,redirect_uri:`${base(req)}/auth/github/callback`,scope:'read:user user:email',state})}`);});
 app.get('/auth/github/callback',async(req,res,next)=>{try{if(cookie.parse(req.headers.cookie||'').pappy_oauth_state!==req.query.state)throw new Error('Invalid OAuth state');const tokenRes=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:process.env.GITHUB_CLIENT_ID,client_secret:process.env.GITHUB_CLIENT_SECRET,code:req.query.code,redirect_uri:`${base(req)}/auth/github/callback`})});const token=(await tokenRes.json()).access_token;if(!token)throw new Error('GitHub authentication failed');const headers={Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'};const [profileRes,emailRes]=await Promise.all([fetch('https://api.github.com/user',{headers}),fetch('https://api.github.com/user/emails',{headers})]);const profile=await profileRes.json();const emails=emailRes.ok?await emailRes.json():[];profile.email=profile.email||emails.find(e=>e.primary&&e.verified)?.email||null;const user=await store.upsertGithubUser(profile);setSession(res,user.id);await store.log(user,'auth','Signed in with GitHub');res.redirect('/app');}catch(error){next(error);}});
 app.post('/api/logout',(req,res)=>{clearSession(res);res.json({ok:true});});
}
module.exports={setup,current,requireUser,install};
