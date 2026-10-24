import React from 'react';
import { cn } from '../../../lib/utils';

/** Shared compact toolbar: fields keep their content-sized width and wrap only
 * when necessary. A field can set flexBasis to override the default 144px. */
export default function SettingsFields({
  disabled,
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<'fieldset'>) {
  return (
    <fieldset
      key={disabled ? 'locked' : 'editable'}
      disabled={disabled}
      aria-disabled={disabled}
      className={cn(
        'flex min-w-0 flex-wrap items-end gap-2 rounded-md border-0 bg-muted/30 px-3 py-2 [&>*]:min-w-0 [&>*]:max-w-full [&>*]:flex-[0_1_9rem]',
        disabled && '[&_a]:pointer-events-none [&_a]:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </fieldset>
  );
}
