// Product integration. Kubai's engine and icon definitions above remain unmodified.
const productPalette = clearTone('主题蓝', '#0866FF', 1);
runtime.palette = productPalette;
let productId = 0;
const availableIds = [];

export function mountKubaiIcon(host, name) {
  const icon = ICONS.find((item) => item.name === name);
  if (!icon) throw new Error(`Unknown Kubai icon: ${name}`);
  const id = availableIds.pop() ?? productId++;
  const accent = getComputedStyle(host).getPropertyValue('--primary').trim();
  const palette = clearTone('主题蓝', /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#0866FF', 1);
  productPalette.colors[id] = palette.colors[0];
  productPalette.edges[id] = palette.edges[0];
  const instance = mountIcon(icon, id, host);
  return {
    hover(value) { instance.hover = value ? 1 : 0; go(instance); },
    destroy() { cancelAnimationFrame(instance.raf); host.replaceChildren(); availableIds.push(id); },
  };
}
