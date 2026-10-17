const markUrl = new URL('./forgon.svg', import.meta.url).href;

export function ForgonMark({ alt = 'Forgon Engine' }: { alt?: string }) {
  return <img className="fg-logo" src={markUrl} width={32} height={32} alt={alt} title="Forgon Engine" draggable={false} />;
}
