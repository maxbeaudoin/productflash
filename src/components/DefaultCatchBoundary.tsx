import { ErrorComponentProps } from '@tanstack/react-router'

export function DefaultCatchBoundary({ error }: ErrorComponentProps) {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <pre className="mt-4 overflow-auto rounded bg-black/5 p-3 text-xs">
        {error.message}
      </pre>
    </div>
  )
}
