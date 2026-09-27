#lang at-exp racket/base
;; Copyright Neil Van Dyke.  See file "info.rkt".

(require "main.rkt")

(doc (require scriblib/footnote))

(doc (section "Introduction")

     @para{@italic{Note: This package of the McFly Runtime is transitional, to
                         support moving packages from PLaneT to the new Racket package system.  At time
                         of this writing, a version of McFly Tools supporting the new package system is
                         not distributed.}}

     @para{McFly began as a way for developers of reusable Racket packages to
                 embed API documentation in the source code of the package.  One documentation
                 convenience is that McFly can reuse some information from the code in the
                 documentation, such as optionally getting procedure type information from some
                 contracts, and argument names from @racket[lambda] forms.}

     (para "McFly itself is actually implemented in two separate PLaneT
packages: this package, McFly Runtime (aka PLaneT package "
           (code "mcfly")
           ", on which packages that use McFly depend); and "
           (hyperlink "http://www.neilvandyke.org/mcfly-tools/" "McFly Tools")
           ", which provides "
           (code "raco")
           "-based tools to help develop packages that use McFly, including things
not strictly documentation-related, such as maintaining PLaneT development
links based on information that is also used for documentation.")

     (margin-note "McFly is so-named due to users of McFly "
                  (hyperlink "http://www.youtube.com/watch?v=O90DliJc6PA&t=0m20s"
                             "saying ``doc'' all the time")
                  ".")

     (para "A package that uses McFly will typically include lots of "
           (racket (doc ...))
           " forms sprinkled throughout at least one of its Racket source code
files. The package will also generally have a few McFly-specific variables
added to its top "
           (filepath "info.rkt")
           " file."))

(doc (subsection "Example")

     (para "The example file "
           (filepath "main.rkt")
           " below shows a use of McFly.")

     (filebox
         "main.rkt"

       (RACKETBLOCK0

        (UNSYNTAX (code "#lang racket/base"))

        (require mcfly
                 racket/contract)

        (provide/contract (celsius->fahrenheit (-> number? number?))
                          (fahrenheit->celsius (-> number? number?)))

        (doc (section "Introduction")

             (para "This package provides procedures for temperature"
                   " conversion. The Wikipedia entries for "
                   (hyperlink "http://en.wikipedia.org/wiki/Celsius"
                              "Celsius")
                   " and "
                   (hyperlink "http://en.wikipedia.org/wiki/Fahrenheit"
                              "Fahrenheit")
                   " were used as authoritative references."))

        (doc (section "Interface"))

        (doc procedure celsius->fahrenheit
             "Returns Celsius temperature "
             (racket c-degrees)
             " as Fahrenheit.  For example:"
             (racketinput (celsius->fahrenheit 0)
                          #,(racketresult 32))
             "Celsius is named after the Swedish astronomer Anders Celsius.")

        (define (celsius->fahrenheit c-degrees)
          (+ (* c-degrees 9/5) 32))

        (doc procedure fahrenheit->celsius
             "Returns Fahrenheit temperature "
             (racket f-degrees)
             " as Celsius.  ``Fahrenheit'' starts with `F'."
             " You know what else starts with `F'? "
             (italic "Freedom!"))

        (define (fahrenheit->celsius f-degrees)
          (* (- f-degrees 32) 5/9))

        (doc history

             (#:planet 1:1 #:date "2000-01-02"

                       "Fixes Y2K bug.")

             (#:planet 1:0 #:date "1997-08-29"

                       "Initial version. Judgment Day by Skynet."))))

     (para "When Scribble formats the documentation for the package of which this "
           (filepath "main.rkt")
           " is a part, McFly Runtime generates Scribble syntax from the "
           (racket doc)
           " forms in "
           (filepath "main.rkt")
           " and from metadata information in the corresponding "
           (filepath "info.rkt")
           " file.  This constitutes a complete formatted manual for the
package.  The package author typically does not edit any "
           (filepath "*.scrbl")
           " files."
           "  (McFly Tools generates a small "
           (filepath "doc.scrbl")
           " file that merely calls McFly Runtime to process "
           (filepath "main.rkt")
           " whenever Scribble goes to format the documentation.  McFly Tools includes this generated "
           (filepath "doc.scrbl")
           " file when making the "
           (filepath "*.plt")
           " archive for upload to the PLaneT server.)")

     (para "Note that the "
           (racket doc)
           " forms in "
           (filepath "main.rkt")
           " do not affect its normal compilation, and effectively are treated as comments.  This is because "
           (racket (require mcfly))
           " imports a dummy "
           (racket doc)
           " syntax that merely transforms to an empty "
           (racket begin)
           " form.")

     (para "Although not shown in this example, as of McFly Runtime version "
           (tt "1:3")
           ", "
           (tt "#lang at-exp")
           " is now supported, so you can now write your documentation like:")

     (verbatim #:indent 2 "@doc[procedure foo @para{This is a @italic{bar}.}]")

     "in addition to:"

     (verbatim #:indent 2 "(doc procedure foo (para \"This is a \" (italic \"bar\") \".\"))"))

@doc[@section{Interface}

             @para{The language of McFly is the @racket[doc] form, as interpreted by McFly Runtime when formatting documentation.}]

(doc (defform*/subs #:id doc
       #:literals (history procedure scribble)
       ((doc procedure id pre-flow ...)
        (doc history   history-entry ...)
        (doc scribble  pre-flow ...)
        (doc           pre-flow ...))
       ((history-entry (maybe-version planet date pre-flow ...))
        (maybe-version code:blank
                       (code:line #:version string))
        (planet        (code:line #:planet  number-colon-number-symbol))
        (date          (code:line #:date    yyyy-mm-dd-string)))

       "Someday, this will be documented, but it's pretty self-explanatory."))

(doc (section "Known Issues")

     (para "Please contact the author with any feedback, to help identify issues and prioritize them.")

     (para "This version of McFly Runtime has a number of known issues (partly
due to heavy reworking, on-and-off, as we learned more about syntax objects and
made some big design changes, without code cleanup) that we have not yet gotten
around to looking into:")

     (itemlist

      (item "Scribble is not linking identifiers.  First assumption is that
some information used by Scribble, perhaps lexical context from the syntax
objects, is not preserved.")

      (item "There is a kludge involving "
            (racket mcfly:para-if-pre-content)
            " that we'd like to get rid of.")

      (item "The ability to infer information for turning "
            (racket (doc procedure ...))
            " to "
            (racket defproc)
            " syntax is limited.  Presently, McFly recognizes only a few forms,
such as "
            (racket define)
            "..."
            (racket lambda)
            " and "
            (racket provide/contract)
            ".  "
            (racket lambda)
            " is handled pretty well.  The only procedure contract combinator
handled at the moment is "
            (racket ->)
            ".  The current internal representation and unification can support
some other things with few changes, but we have not yet gotten to it.")

      (item "It could use better testing.")))

(doc history

     (#:planet 2:2 #:date "2016-02-26"
               (itemlist
                (item "Commented out some tests to fix builds.")))

     (#:planet 2:1 #:date "2016-02-25"
               (itemlist
                (item "Fixed deps.")))

     (#:planet 2:0 #:date "2016-02-21"
               (itemlist
                (item "Kludging to support the new package system, hopefully
without disrupting the PLaneT support too much.")))

     (#:planet 1:3 #:date "2012-07-14"
               (itemlist
                (item (tt "#lang at-exp")
                      " is now supported. (Thanks to Asumu Takikawa for
suggesting.)")))

     (#:planet 1:2 #:date "2012-07-13"
               (itemlist
                (item "Made "
                      (racket parse-planet-symbol-string/ignore-equals)
                      " more permissive.  (Thanks to Asumu Takikawa.)")
                (item "Documentation fixes.  (Thanks to Tim Brown.)")))

     (#:planet 1:1 #:date "2012-06-13"
               (itemlist
                (item "When "
                      (racket mcfly-subtitle)
                      " is used, the "
                      (racket name)
                      " is no longer put in boldface in generated titles by
McFly.  (That was an old PLT convention that was visible in the documentation
index, but apparently is not used anymore.)  Instead, if "
                      (racket mcfly-subtitle)
                      " is used, and "
                      (racket name)
                      " is exactly equal to the name part of the PLaneT package
spec (sans "
                      (code ".plt")
                      "), then the name part is put in "
                      (racket code)
                      " in the title.")
                (item "Documentation changes.")))

     (#:planet 1:0 #:date "2012-06-11"
               "First alpha release.  Not for general use."))

;; TODO: We might want to intercept errors on user-supplied expressions, to at
;; least give location info.  For example, "(italic not)" in "soundex.rkt"
;; resulted in:
;;
;; (cd /home/user/racket/soundex && scribble soundex.scrbl)
;; italic: contract violation, expected <pre-content?>, given: #<procedure:not>
;;   contract from <collects>/scribble/base.rkt, blaming
;;     /home/user/racket/soundex/soundex.scrbl
;;   contract:
;;     (->* () #:rest (listof pre-content?) element?)
;;   at: <collects>/scribble/base.rkt:293.2
;;
;;  === context ===
;; /usr/local/racket-5.1.2/lib/racket/collects/racket/contract/private/blame.rkt:58:0: raise-blame-error
;; /usr/local/racket-5.1.2/lib/racket/collects/racket/private/map.rkt:45:11: for-each
;; /usr/local/racket-5.1.2/lib/racket/collects/racket/contract/private/misc.rkt:565:14
;; /usr/local/racket-5.1.2/lib/racket/collects/racket/contract/private/prop.rkt:180:10
;; /usr/local/racket-5.1.2/lib/racket/collects/scribble/private/manual-proc.rkt:137:0: *defproc
;; /home/user/racket/soundex/soundex.scrbl: [running body]
;; /usr/local/racket-5.1.2/lib/racket/collects/racket/private/map.rkt:18:11: map
;; /usr/local/racket-5.1.2/lib/racket/collects/scribble/run.rkt: [running body]

;; TODO: Add "doc include".  Use "racket/include" for this?

;; TODO: Add "doc form" and "doc forms" (or "syntax" instead of "form").

;; TODO: Add "doc parameter"?

;; TODO: Add "doc struct". Different forms for "stuct" vs. "define-struct"?

;; TODO: Also save information from "provide"-like forms that rename the
;; identifiers.

;; TODO: Maybe don't keep the hash across file boundaries For each file, after
;; reading, do a pass and update the "doc procedure", "doc Syntax", and others.
;; See how the lexical context or whatever that Scribble seems to need works
;; out first.
