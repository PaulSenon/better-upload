'use client';

import type { UploadControl } from '@open-upload/react';
import { UploadCloud } from 'lucide-react';
import { type DragEvent, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface UploadDropzoneProps {
  /** From `useUpload(endpoint).control({ input })`: accept rules, multiple, and the upload trigger. */
  control: UploadControl;
  disabled?: boolean;
  className?: string;
  /** Main text. Defaults to a short call to action. */
  label?: string;
  /** Secondary text. Defaults to the accepted types and size limit from the contract. */
  hint?: string;
}

/** Drag-and-drop zone and file picker bound to an upload endpoint. Keyboard and screen-reader friendly. */
export function UploadDropzone({ control, disabled, className, label, hint }: UploadDropzoneProps) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (!disabled && event.dataTransfer.files.length > 0) control.onFiles(event.dataTransfer.files);
  };

  const rules = control.rules;
  const defaultHint = [
    rules?.accept?.join(', '),
    rules?.maxFileSize ? `up to ${rules.maxFileSize}` : undefined,
    control.multiple && rules?.maxFiles ? `${rules.maxFiles} files max` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <label
      htmlFor={inputId}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      data-dragging={dragging || undefined}
      data-disabled={disabled || undefined}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center transition-colors',
        'hover:bg-muted/50 focus-within:ring-2 focus-within:ring-ring',
        'data-[dragging]:border-primary data-[dragging]:bg-primary/5',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        className,
      )}
    >
      <UploadCloud className="size-8 text-muted-foreground" aria-hidden />
      <span className="text-sm font-medium">
        {label ?? (control.multiple ? 'Drop files here or click to browse' : 'Drop a file here or click to browse')}
      </span>
      {(hint ?? defaultHint) ? <span className="text-xs text-muted-foreground">{hint ?? defaultHint}</span> : null}
      <input
        ref={input}
        id={inputId}
        type="file"
        className="sr-only"
        accept={control.accept}
        multiple={control.multiple}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.files?.length) control.onFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </label>
  );
}
