/**
 * 生成多尺寸 Windows 图标 assets/icon.ico 与 assets/tray.png。
 *
 * 必须用 Electron 跑（scripts/pack.mjs 会自动调用）：
 *   node_modules\.bin\electron scripts/make-icon.js
 *
 * 注意 nativeImage **不支持 SVG**：createFromDataURL('data:image/svg+xml,...')
 * 返回的是空图（这正是托盘图标一直空白的原因）。所以这里开一个隐藏的透明窗口，
 * 把 SVG 当网页渲染再 capturePage 拿到带 alpha 的位图，然后按尺寸缩放。
 *
 * ICO 容器从 Vista 起支持直接内嵌 PNG，不需要手写 BMP/DIB 编码。
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, nativeImage } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const ICO = path.join(ASSETS, 'icon.ico');
const TRAY = path.join(ASSETS, 'tray.png');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const RENDER_AT = 256;

/** 应用标志：朱砂圆角方块 + 衬线 L + 右下角一点，和界面里的 .brand 一致 */
function logoHtml(size) {
  const r = Math.round(size * 0.22);
  const fontSize = Math.round(size * 0.62);
  const dot = Math.max(1, Math.round(size * 0.075));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  </style></head><body>
  <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${r}" fill="#b3402f"/>
    <text x="${size * 0.455}" y="${size * 0.745}" font-family="Georgia,'Times New Roman',serif"
          font-size="${fontSize}" font-weight="600" text-anchor="middle" fill="#fdf6f2">L</text>
    <circle cx="${size * 0.775}" cy="${size * 0.7}" r="${dot}" fill="#fdf6f2"/>
  </svg></body></html>`;
}

async function rasterize() {
  const win = new BrowserWindow({
    width: RENDER_AT,
    height: RENDER_AT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(logoHtml(RENDER_AT))}`);
  // 等一帧，确保字体与 SVG 都已绘制
  await new Promise((r) => setTimeout(r, 400));

  let img = await win.webContents.capturePage();
  win.destroy();

  const s = img.getSize();
  if (s.width !== RENDER_AT || s.height !== RENDER_AT) {
    // 高 DPI 下 capturePage 会按缩放比放大，缩回基准尺寸
    img = img.resize({ width: RENDER_AT, height: RENDER_AT, quality: 'best' });
  }
  if (img.isEmpty()) throw new Error('capturePage 返回空图');
  return img;
}

/** 把一组 PNG 拼成 ICO */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;

  entries.forEach((e, i) => {
    const at = i * 16;
    // 256 在这个字节里必须写 0
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, at + 0);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, at + 1);
    dir.writeUInt8(0, at + 2); // 调色板
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // planes
    dir.writeUInt16LE(32, at + 6); // 位深
    dir.writeUInt32LE(e.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/** 抽查四角是否透明，确认 alpha 没被压成白底 */
function alphaReport(img) {
  const { width, height } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const at = (x, y) => bmp[(y * width + x) * 4 + 3];
  return {
    corner: at(1, 1),
    center: at(Math.floor(width / 2), Math.floor(height / 2)),
    edge: at(Math.floor(width / 2), 1),
    size: `${width}x${height}`,
  };
}

app.disableHardwareAcceleration(); // 离屏渲染时软件光栅更稳定

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(ASSETS, { recursive: true });
    const base = await rasterize();

    const a = alphaReport(base);
    console.log(`[icon] 栅格化 ${a.size}，alpha 抽查：角=${a.corner} 边=${a.edge} 心=${a.center}`);
    if (a.center === 0) throw new Error('图标中心是透明的，说明什么都没画上');

    const entries = SIZES.map((size) => ({
      size,
      png: (size === RENDER_AT ? base : base.resize({ width: size, height: size, quality: 'best' })).toPNG(),
    }));

    fs.writeFileSync(ICO, buildIco(entries));
    // 托盘用 32px PNG，nativeImage 读 PNG 没问题
    fs.writeFileSync(TRAY, entries.find((e) => e.size === 32).png);

    const total = entries.reduce((n, e) => n + e.png.length, 0);
    console.log(`[icon] 已写入 ${ICO}`);
    console.log(`[icon] 尺寸 ${SIZES.join(' / ')} px，载荷共 ${(total / 1024).toFixed(1)} KB`);
    console.log(`[icon] 已写入 ${TRAY}`);
    app.exit(0);
  } catch (e) {
    console.error('[icon] 失败：', e.message);
    app.exit(1);
  }
});
