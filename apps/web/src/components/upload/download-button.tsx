import { Download } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface DownloadButtonProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  /** From `client.<endpoint>.link({ input })`: a stable link, re-authorized on every click. */
  href: string;
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
}

/**
 * A plain link handed to the browser's own download manager: works without JavaScript, survives tab closes, and
 * "retry" in the browser always works because the link itself never expires.
 */
export function DownloadButton({ href, variant = 'outline', className, children, ...props }: DownloadButtonProps) {
  return (
    <a href={href} download className={cn(buttonVariants({ variant }), className)} {...props}>
      <Download className="size-4" aria-hidden />
      {children ?? 'Download'}
    </a>
  );
}
