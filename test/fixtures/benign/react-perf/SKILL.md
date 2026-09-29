---
name: react-perf
description: React performance rules.
---

# React performance

```tsx
const Row = memo(function Row({ item }: Props) {
  return <li>{item.name}</li>;
});
```

Avoid creating objects in render. Use `useMemo` for expensive derived data.

