import { useEffect, useState } from 'react';
import { getThumbnail } from '../render/thumbnails';

export function PartThumb({ id, color = 71, size = 64 }: { id: string; color?: number; size?: number }) {
  const [url, setUrl] = useState<string>('');
  useEffect(() => {
    let alive = true;
    getThumbnail(id, color).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [id, color]);
  return url ? <img src={url} width={size} height={size} alt="" /> : <div className="thumb-wait" style={{ width: size, height: size }} />;
}
