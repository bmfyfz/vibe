import type { ReactNode } from "react";

// One hand drew these: a 16-unit box, a 1.5 stroke, round joins. They carry
// no meaning by themselves, so each is hidden from a screen reader and the
// control it sits in says what it does.
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const ChevronIcon = () => (
  <Icon>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Icon>
);

export const BackIcon = () => (
  <Icon>
    <path d="M9.5 3.5 5 8l4.5 4.5" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);

export const MenuIcon = () => (
  <Icon>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Icon>
);

export const ClipIcon = () => (
  <Icon>
    <path d="M13 7.5 8.2 12.3a2.8 2.8 0 0 1-4-4L9.1 3.4a1.9 1.9 0 0 1 2.7 2.7L7 10.9a1 1 0 0 1-1.4-1.4L10 5.1" />
  </Icon>
);

export const DownloadIcon = () => (
  <Icon>
    <path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10" />
  </Icon>
);

export const ReactIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M5.8 9.4a2.6 2.6 0 0 0 4.4 0M6.2 6.4v.2M9.8 6.4v.2" />
  </Icon>
);

export const TagIcon = () => (
  <Icon>
    <path d="M2.5 8.3V3.5a1 1 0 0 1 1-1h4.800l5.200 5.200a1 1 0 0 1 0 1.400l-4.400 4.400a1 1 0 0 1-1.400 0Z" />
    <path d="M5.4 5.4v.1" />
  </Icon>
);

export const EditIcon = () => (
  <Icon>
    <path d="m10.5 3 2.500 2.500L6 12.500l-3 .500.500-3Z" />
  </Icon>
);

export const TrashIcon = () => (
  <Icon>
    <path d="M3 4.500h10M6.500 4.500V3h3v1.500M4.500 4.500l.500 8.500h6l.500-8.500" />
  </Icon>
);

export const SignOutIcon = () => (
  <Icon>
    <path d="M6.500 2.500h-3v11h3M10 5l3 3-3 3M13 8H6.500" />
  </Icon>
);

export const SyncIcon = () => (
  <Icon>
    <path d="M2.500 6.500A5.500 5.500 0 0 1 12.800 5M13.500 2.500V5.200h-2.700M13.500 9.500A5.500 5.500 0 0 1 3.200 11M2.500 13.500v-2.700h2.700" />
  </Icon>
);
