import { getClientBootBanner } from './app.js';

function bootstrapClient(): void {
  const banner = document.getElementById('hud-boot');
  if (banner) {
    banner.textContent = getClientBootBanner();
  }

  const canvas = document.getElementById('viewport');
  if (canvas instanceof HTMLCanvasElement) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#050a0e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }
}

bootstrapClient();
