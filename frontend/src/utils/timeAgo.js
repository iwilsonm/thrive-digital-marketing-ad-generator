const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

export default function timeAgo(dateInput) {
  if (!dateInput) return '';

  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(date.getTime())) return '';

  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 0) return 'just now';
  if (seconds < MINUTE) return `${seconds}s ago`;
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m ago`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h ago`;
  if (seconds < DAY * 2) return 'yesterday';
  if (seconds < DAY * 7) return `${Math.floor(seconds / DAY)}d ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
