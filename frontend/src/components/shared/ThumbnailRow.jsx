import React, { useState } from 'react';

const THUMB_SIZE = { width: 100, height: 100 };

export default function ThumbnailRow({ images = [], maxVisible = 6, isLoading = false, skeletonCount = 4 }) {
  const visible = images.slice(0, maxVisible);
  const overflow = images.length - maxVisible;

  if (isLoading) {
    return (
      <div className="thumbnail-row ed-scrollbar">
        {Array.from({ length: skeletonCount }).map((_, i) => (
          <div
            key={i}
            className="thumbnail-skeleton"
            style={{ width: THUMB_SIZE.width, height: THUMB_SIZE.height, flexShrink: 0 }}
          />
        ))}
      </div>
    );
  }

  if (!images.length) return null;

  return (
    <div className="thumbnail-row ed-scrollbar">
      {visible.map((img, i) => (
        <ThumbItem key={img.id || i} img={img} />
      ))}
      {overflow > 0 && (
        <div
          className="thumbnail-row-overflow"
          style={{ width: THUMB_SIZE.width, height: THUMB_SIZE.height }}
        >
          +{overflow}
        </div>
      )}
    </div>
  );
}

function ThumbItem({ img }) {
  const [loaded, setLoaded] = useState(false);
  const aspect = img.aspect_ratio || '1:1';

  return (
    <div className="thumbnail-row-item" style={{ width: THUMB_SIZE.width, height: THUMB_SIZE.height }}>
      {!loaded && (
        <div className="thumbnail-skeleton" style={{ width: '100%', height: '100%', position: 'absolute', inset: 0 }} />
      )}
      <img
        src={img.imageUrl || img.image_url || img.url}
        alt={img.headline || 'Ad thumbnail'}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        style={{ opacity: loaded ? 1 : 0, transition: 'opacity 0.2s' }}
      />
      <span className="thumbnail-row-badge">{aspect}</span>
    </div>
  );
}
