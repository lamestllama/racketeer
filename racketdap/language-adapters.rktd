;; Copyright (c) 2026 Eric Parsonage
;; SPDX-License-Identifier: Apache-2.0 OR MIT
((profile
  (match (language rhombus)
         (variants rhombus/and_meta
                   (lib "rhombus/main.rhm") (lib "rhombus/and_meta.rhm"))
         (reader (submod rhombus reader))
         (reader (submod rhombus/and_meta reader)))
  (bindings (expanded+ #((file "adapters/rhombus-debugger.rkt") bindings #f)))
  (editor
   (rename (expanded-graph #((file "adapters/rhombus-rename.rkt") rename #f)))
   (declarations #((file "adapters/rhombus.rkt") declarations #f))
   (calls #((file "adapters/rhombus.rkt") calls #f) (triggers "(" ","))
   (completion (expanded+ #((file "adapters/rhombus-completion.rkt") completion #f))))
  (debugger
    (expressions (runtime-interaction #((file "adapters/rhombus-debugger.rkt") lower-expression #f)))))
 (profile
  (match (reader SRFI-105))
  (bootstrap (auto #((file "adapters/schemeplus.rkt") interactions #f)))))
