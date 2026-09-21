export const LOGIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Roamgate login</title>
<link rel="icon" type="image/png" href="/roamgate-icon-192.png">
<style>
  *{box-sizing:border-box}
  :root{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#eeeef0;
    background:#141516;color-scheme:dark;--panel:#1c1d1f;--border:#383a3d;--muted:#a9abb0;
    --input:#141516;--accent:#a8c5ff;--error:#ffaaaa}
  body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;
    padding:32px 20px;background:radial-gradient(ellipse at 50% 0%,#a8c5ff0d,transparent 65%)}
  main{width:100%;max-width:400px}
  .brand{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:28px;
    font-size:24px;font-weight:650;letter-spacing:-.7px}
  .brand img{width:48px;height:48px;border-radius:13px}
  .card{padding:32px;border:1px solid var(--border);border-radius:20px;background:var(--panel);
    box-shadow:0 16px 48px #00000014}
  h1{margin:0 0 8px;font-size:24px;font-weight:650;letter-spacing:-.6px}
  p{margin:0;color:var(--muted);font-size:14px;line-height:1.6}
  form{margin-top:28px}
  label{display:block;margin-bottom:8px;font-size:13px;font-weight:600}
  .password{position:relative}
  input{width:100%;min-height:48px;padding:12px 64px 12px 14px;border-radius:10px;
    border:1px solid var(--border);background:var(--input);color:inherit;font:inherit;font-size:16px}
  input::placeholder{color:var(--muted);opacity:.8}
  button{font:inherit;cursor:pointer}
  :focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  input:focus-visible{outline-offset:1px}
  .reveal{position:absolute;right:4px;top:4px;min-width:52px;min-height:40px;padding:0 8px;
    border:0;border-radius:7px;background:transparent;color:var(--muted);font-size:12px;font-weight:600}
  .reveal:hover{color:var(--accent)}
  .submit{width:100%;min-height:48px;padding:12px;margin-top:4px;border:1px solid transparent;
    border-radius:10px;background:#ececee;color:#202124;font-size:14px;font-weight:650}
  .submit:hover:not(:disabled){background:#fff}
  .submit:disabled{opacity:.65;cursor:wait}
  .err{color:var(--error);font-size:13px;line-height:1.5;min-height:24px;margin:10px 0 6px}
  .note{margin-top:24px;text-align:center;font-size:12px}
  footer{margin-top:24px;text-align:center;color:var(--muted);font-size:12px;line-height:1.6}
  @media(prefers-color-scheme:light){
    :root{background:#f5f5f3;color:#252629;color-scheme:light;--panel:#fff;--border:#dcdde0;
      --muted:#64666d;--input:#fafafa;--accent:#315fb4;--error:#b42332}
    .submit{background:#292a2c;color:#fff}.submit:hover:not(:disabled){background:#414245}
  }
  @media(max-width:380px){.card{padding:24px}body{padding:24px 16px}}
</style>
</head>
<body>
<main>
  <div class="brand"><img src="/roamgate-icon-192.png" alt="" width="48" height="48"><span>Roamgate</span></div>
  <section class="card" aria-labelledby="heading">
    <h1 id="heading">Welcome back</h1>
    <p>Log in to access your workspaces.</p>
    <form id="login">
      <label for="pw">Password or token</label>
      <div class="password">
        <input id="pw" name="password" type="password" placeholder="Password or token"
          autocomplete="current-password" autocapitalize="none" spellcheck="false" required autofocus aria-describedby="err">
        <button class="reveal" id="reveal" type="button" aria-label="Show password" aria-controls="pw" aria-pressed="false">Show</button>
      </div>
      <div class="err" id="err" role="alert" aria-live="polite"></div>
      <button class="submit" id="btn" type="submit">Log in</button>
    </form>
    <p class="note">Use the password or token configured on your server.</p>
    <noscript><p class="err">Enable JavaScript to log in to Roamgate.</p></noscript>
  </section>
  <footer>Your workspace, wherever you are.</footer>
</main>
<script>
  const form=document.getElementById('login'),pw=document.getElementById('pw'),btn=document.getElementById('btn'),err=document.getElementById('err'),reveal=document.getElementById('reveal');
  reveal.onclick=()=>{
    const show=pw.type==='password';
    pw.type=show?'text':'password';
    reveal.textContent=show?'Hide':'Show';
    reveal.setAttribute('aria-label',show?'Hide password':'Show password');
    reveal.setAttribute('aria-pressed',String(show));
  };
  form.onsubmit=async event=>{
    event.preventDefault();
    if(btn.disabled)return;
    err.textContent='';
    pw.removeAttribute('aria-invalid');
    btn.disabled=true;btn.textContent='Logging in...';
    try{
      const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:pw.value})});
      if(r.ok){location.replace('/'+location.hash);return;}
      if(r.status===401){
        err.textContent='Wrong password or token. Try again.';
        pw.setAttribute('aria-invalid','true');pw.value='';pw.focus();
      }else{err.textContent='Unable to log in. Please try again.';}
    }catch{err.textContent='Cannot reach the server. Check your connection and try again.';}
    finally{btn.disabled=false;btn.textContent='Log in';}
  };
</script>
</body>
</html>`;
