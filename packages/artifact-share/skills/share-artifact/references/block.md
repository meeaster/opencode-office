# block

Mermaid's documentation examples, from Pele 1.13.0's test corpus; each renders on the site. Written by `pnpm run vendor-artifact-share` in opencode-office; don't edit.

```mermaid
block
  a b c
```

```mermaid
block
  columns 3
  a b c d
```

```mermaid
block
  columns 3
  a["A label"] b:2 c:2 d
```

```mermaid
block
    block
      D
    end
    A["A: I am a wide one"]
```

```mermaid
block
  columns 3
  a:3
  block:group1:2
    columns 2
    h i j k
  end
  g
  block:group2:3
    %% columns auto (default)
    l m n o p q r
  end
```

```mermaid
block
  block
    columns 1
    a["A label"] b c d
  end
```

```mermaid
block
    id1("This is the text in the box")
```

```mermaid
block
    id1(["This is the text in the box"])
```

```mermaid
block
    id1[["This is the text in the box"]]
```

```mermaid
block
    id1[("Database")]
```

```mermaid
block
    id1(("This is the text in the circle"))
```

```mermaid
block
  id1>"This is the text in the box"]
```

```mermaid
block
    id1{"This is the text in the box"}
```

```mermaid
block
    id1{{"This is the text in the box"}}
```

```mermaid
block
  id1[/"This is the text in the box"/]
  id2[\"This is the text in the box"\]
  A[/"Christmas"\]
  B[\"Go shopping"/]
```

```mermaid
block
    id1((("This is the text in the circle")))
```

```mermaid
block
  blockArrowId<["Label"]>(right)
  blockArrowId2<["Label"]>(left)
  blockArrowId3<["Label"]>(up)
  blockArrowId4<["Label"]>(down)
  blockArrowId5<["Label"]>(x)
  blockArrowId6<["Label"]>(y)
  blockArrowId7<["Label"]>(x, down)
```

```mermaid
block
  columns 3
  a space b
  c   d   e
```

```mermaid
block
  ida space:3 idb idc
```

```mermaid
block
  A space B
  A-->B
```

```mermaid
block
  A space:2 B
  A-- "X" -->B
```

```mermaid
block
  A space B
  A --> B
```

```mermaid
  block
    A
    style A fill#969;
```
