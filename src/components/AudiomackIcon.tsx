interface AudiomackIconProps {
  size?: number;
  className?: string;
}

export function AudiomackIcon({ size = 16, className }: AudiomackIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 15 L8 5 L12 19 L16 9 L21 15" />
    </svg>
  );
}
