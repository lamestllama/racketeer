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
  (bootstrap (auto #((file "adapters/schemeplus.rkt") interactions #f))))
 (profile
  (match (reader htdp/bsl/lang/reader) (language lang/htdp-beginner))
  (bootstrap (auto #((file "adapters/teaching.rkt") interactions bsl)))
  (bindings (expanded+ #((file "adapters/teaching-bindings.rkt") bindings bsl)))
  (editor
   (rename (expanded-graph #((file "adapters/teaching-rename.rkt") rename bsl)))
   (declarations #((file "adapters/teaching-editor.rkt") declarations bsl))
   (calls #((file "adapters/teaching-editor.rkt") calls bsl))
   (completion (expanded+ #((file "adapters/teaching-editor.rkt") completion bsl)))))
 (profile
  (match (reader htdp/isl+/lang/reader) (language lang/htdp-intermediate-lambda))
  (bootstrap (auto #((file "adapters/teaching.rkt") interactions isl+)))
  (bindings (expanded+ #((file "adapters/teaching-bindings.rkt") bindings isl+)))
  (editor
   (rename (expanded-graph #((file "adapters/teaching-rename.rkt") rename isl+)))
   (declarations #((file "adapters/teaching-editor.rkt") declarations isl+))
   (calls #((file "adapters/teaching-editor.rkt") calls isl+))
   (completion (expanded+ #((file "adapters/teaching-editor.rkt") completion isl+)))))
 (profile
  (match (reader htdp/asl/lang/reader) (language lang/htdp-advanced))
  (bootstrap (auto #((file "adapters/teaching.rkt") interactions asl)))
  (bindings (expanded+ #((file "adapters/teaching-bindings.rkt") bindings asl)))
  (editor
   (rename (expanded-graph #((file "adapters/teaching-rename.rkt") rename asl)))
   (declarations #((file "adapters/teaching-editor.rkt") declarations asl))
   (calls #((file "adapters/teaching-editor.rkt") calls asl))
   (completion (expanded+ #((file "adapters/teaching-editor.rkt") completion asl)))))
 (profile
  (match (reader htdp/bsl+/lang/reader) (language lang/htdp-beginner-abbr))
  (bootstrap (auto #((file "adapters/teaching.rkt") interactions bsl+)))
  (bindings (expanded+ #((file "adapters/teaching-bindings.rkt") bindings bsl+)))
  (editor
   (rename (expanded-graph #((file "adapters/teaching-rename.rkt") rename bsl+)))
   (declarations #((file "adapters/teaching-editor.rkt") declarations bsl+))
   (calls #((file "adapters/teaching-editor.rkt") calls bsl+))
   (completion (expanded+ #((file "adapters/teaching-editor.rkt") completion bsl+)))))
 (profile
  (match (reader htdp/isl/lang/reader) (language lang/htdp-intermediate))
  (bootstrap (auto #((file "adapters/teaching.rkt") interactions isl)))
  (bindings (expanded+ #((file "adapters/teaching-bindings.rkt") bindings isl)))
  (editor
   (rename (expanded-graph #((file "adapters/teaching-rename.rkt") rename isl)))
   (declarations #((file "adapters/teaching-editor.rkt") declarations isl))
   (calls #((file "adapters/teaching-editor.rkt") calls isl))
   (completion (expanded+ #((file "adapters/teaching-editor.rkt") completion isl))))))
