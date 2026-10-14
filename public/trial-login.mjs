const form = document.querySelector('form');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  const message = document.getElementById('login-message');
  button.disabled = true; button.textContent = '正在进入…'; message.textContent = '';
  try {
    const response = await fetch('/trial-login', {method:'POST',headers:{Accept:'application/json'},body:new URLSearchParams(new FormData(form)),signal:AbortSignal.timeout(20000)});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '暂时无法登录，请稍后重试。');
    window.location.assign('/');
  } catch (e) {
    message.textContent = e.name === 'TimeoutError' ? '网络响应较慢，请再试一次。' : e.message;
    button.disabled = false; button.textContent = '进入试用';
  }
});
