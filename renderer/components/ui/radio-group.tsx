"use client"

import * as React from "react"
import { Circle } from "lucide-react"
import { cn } from "lib/utils"

interface RadioGroupContextValue {
  value?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
  name?: string
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null)

export interface RadioGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
  name?: string
}

const RadioGroup = React.forwardRef<HTMLDivElement, RadioGroupProps>(
  ({ className, value, defaultValue, onValueChange, disabled = false, name, children, ...props }, ref) => {
    const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue)
    const isControlled = value !== undefined
    const currentValue = isControlled ? value : uncontrolledValue

    const handleValueChange = React.useCallback(
      (val: string) => {
        if (!isControlled) {
          setUncontrolledValue(val)
        }
        onValueChange?.(val)
      },
      [isControlled, onValueChange]
    )

    const generatedName = React.useId()

    return (
      <RadioGroupContext.Provider
        value={{
          value: currentValue,
          onValueChange: handleValueChange,
          disabled,
          name: name || generatedName,
        }}
      >
        <div
          ref={ref}
          role="radiogroup"
          className={cn("grid gap-2", className)}
          {...props}
        >
          {children}
        </div>
      </RadioGroupContext.Provider>
    )
  }
)
RadioGroup.displayName = "RadioGroup"

export interface RadioGroupItemProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string
}

const RadioGroupItem = React.forwardRef<HTMLButtonElement, RadioGroupItemProps>(
  ({ className, value, id, disabled, onClick, ...props }, ref) => {
    const context = React.useContext(RadioGroupContext)

    if (!context) {
      throw new Error("RadioGroupItem must be used within a RadioGroup")
    }

    const isChecked = context.value === value
    const isDisabled = disabled || context.disabled

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      if (isDisabled) return
      context.onValueChange?.(value)
      onClick?.(e)
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault()
        if (!isDisabled) {
          context.onValueChange?.(value)
        }
      }
    }

    return (
      <button
        ref={ref}
        type="button"
        role="radio"
        id={id}
        aria-checked={isChecked}
        data-state={isChecked ? "checked" : "unchecked"}
        disabled={isDisabled}
        tabIndex={isChecked ? 0 : -1}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={cn(
          "aspect-square h-4 w-4 rounded-full border border-primary text-primary ring-offset-background flex items-center justify-center shrink-0 cursor-pointer",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      >
        {isChecked && (
          <Circle className="h-2 w-2 fill-current text-current" />
        )}
      </button>
    )
  }
)
RadioGroupItem.displayName = "RadioGroupItem"

export { RadioGroup, RadioGroupItem }
