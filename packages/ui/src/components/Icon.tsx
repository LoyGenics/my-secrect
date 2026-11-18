import type { SVGProps } from 'react';
import {
  Activity,
  Archive,
  ArchiveRestore,
  ArrowUpDown,
  Braces,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Copy,
  CornerDownLeft,
  CreditCard,
  Dices,
  Ellipsis,
  ExternalLink,
  Download,
  Eye,
  EyeOff,
  FileText,
  FileUp,
  Fingerprint,
  Folder,
  IdCard,
  Image,
  Images,
  Info,
  KeyRound,
  KeySquare,
  Landmark,
  Languages,
  LayoutList,
  LifeBuoy,
  Link2,
  ListChecks,
  LoaderCircle,
  Lock,
  LockOpen,
  Mail,
  Menu,
  Monitor,
  Moon,
  NotebookPen,
  Palette,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  Server,
  Settings,
  Shapes,
  ShieldCheck,
  Share2,
  SquareTerminal,
  Star,
  Sun,
  Tag,
  Timer,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';
import { iconSize, iconStrokeWidth, type IconName, type IconSize } from '../icons';
import { cn } from '../utils';

const glyphs: Record<IconName, LucideIcon> = {
  items: LayoutList,
  favorite: Star,
  trash: Trash2,
  archive: Archive,
  unarchive: ArchiveRestore,
  gallery: Images,
  share: Share2,
  health: Activity,
  settings: Settings,
  security: Fingerprint,
  export: Download,
  import: Upload,
  recovery: LifeBuoy,
  lock: Lock,
  unlock: LockOpen,
  tag: Tag,
  credentials: KeyRound,
  finance: Landmark,
  identity: IdCard,
  developer: SquareTerminal,
  notes: NotebookPen,
  media: Image,
  documents: FileText,
  collections: Folder,
  passkey: KeySquare,
  card: CreditCard,
  apiKey: Braces,
  custom: Shapes,
  menu: Menu,
  search: Search,
  add: Plus,
  generate: Dices,
  regenerate: RefreshCw,
  close: X,
  edit: Pencil,
  restore: Undo2,
  show: Eye,
  hide: EyeOff,
  copy: Copy,
  check: Check,
  back: ChevronLeft,
  forward: ChevronRight,
  expand: ChevronDown,
  sort: ArrowUpDown,
  enter: CornerDownLeft,
  file: FileUp,
  more: Ellipsis,
  open: ExternalLink,
  timer: Timer,
  link: Link2,
  attachment: Paperclip,
  server: Server,
  language: Languages,
  appearance: Palette,
  light: Sun,
  dark: Moon,
  system: Monitor,
  checklist: ListChecks,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
  reused: Repeat,
  expiring: CalendarClock,
  spinner: LoaderCircle,
  mail: Mail,
  shield: ShieldCheck,
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref' | 'name'> {
  name: IconName;
  /** Token size (default `md`, 16px) or a px number. */
  size?: IconSize | number;
  /**
   * Accessible name. Omit for decorative icons next to visible text (the
   * default: aria-hidden). Give it only when the icon is the sole content;
   * prefer IconButton, which requires a label, for icon-only controls.
   */
  label?: string;
}

/**
 * The one icon component for web/desktop. Lucide glyph by semantic name,
 * one stroke weight, sizes from tokens, `currentColor` so it follows text.
 */
export function Icon({ name, size = 'md', label, className, ...rest }: IconProps) {
  const Glyph = glyphs[name];
  const px = typeof size === 'number' ? size : iconSize[size];
  return (
    <Glyph
      size={px}
      strokeWidth={iconStrokeWidth}
      absoluteStrokeWidth={false}
      className={cn('ms-icon', name === 'spinner' && 'ms-icon--spin', className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable="false"
      {...rest}
    />
  );
}
