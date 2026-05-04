export default function scrollIntoColumn(ref, column = 'right') {
  const el = ref?.current || ref;
  if (!el) return;

  const columnClass = column === 'left' ? '.ad-studio-left' : '.ad-studio-right';
  const container = el.closest(columnClass);

  if (container) {
    const elTop = el.offsetTop - container.offsetTop;
    container.scrollTo({ top: elTop - 16, behavior: 'smooth' });
  } else {
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}
