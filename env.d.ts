declare const MACRO: {
  VERSION: string
  BUILD_TIME: string
  PACKAGE_URL?: string
  NATIVE_PACKAGE_URL?: string
  VERSION_CHANGELOG?: string
}

declare module '*.node' {
  const value: unknown
  export default value
}

// Minimal ambient types for the React pieces referenced from type-only
// positions (`React.ReactNode`, `JSX.Element`). Full @types/react conflicts
// with react@19's own compiler-runtime typings (the `c` export), so this
// snapshot declares only the handful of shapes the source actually names.
namespace React {
  type ReactNode = any
  type Dispatch<T> = (value: T) => void
  type SetStateAction<S> = S | ((prev: S) => S)
}

namespace JSX {
  type Element = any
}
