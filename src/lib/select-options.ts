import { Children, Fragment, isValidElement, type ReactNode } from 'react'

export interface SelectOption {
  value: string
  label: string
  disabled: boolean
  hidden: boolean
  group?: string
}

function text(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child) ? text(child.props.children) : String(child)).join('')
}

export function selectOptions(children: ReactNode): SelectOption[] {
  const result: SelectOption[] = []
  function walk(nodes: ReactNode, group?: string, disabled = false, hidden = false) {
    Children.forEach(nodes, child => {
      if (!isValidElement<{ value?: string | number; label?: string; children?: ReactNode; disabled?: boolean; hidden?: boolean }>(child)) return
      if (child.type === Fragment) walk(child.props.children, group, disabled, hidden)
      if (child.type === 'optgroup') walk(child.props.children, child.props.label, disabled || !!child.props.disabled, hidden || !!child.props.hidden)
      if (child.type === 'option') {
        const content = text(child.props.children)
        result.push({ value: String(child.props.value ?? content), label: child.props.label ?? content, disabled: disabled || !!child.props.disabled, hidden: hidden || !!child.props.hidden, group })
      }
    })
  }
  walk(children)
  return result
}

export function selectedOption(options: SelectOption[], value: string): SelectOption | undefined {
  return options.find(option => option.value === value) ?? options.find(option => !option.disabled) ?? options[0]
}

// Radix values must be non-empty. JSON encoding also avoids collisions with real
// product/category IDs and allows optional selects to explicitly choose "" again.
export const selectMenuValue = (value: string) => JSON.stringify(value)
