#lang setup/infotab

(define mcfly-planet       'neil/mcfly:2:2)
(define collection         "mcfly")
(define name               "McFly Runtime")
(define mcfly-subtitle     "Embedded Package Documentation for Racket")
(define blurb              (list name ": Embedded Package Documentation"))
(define homepage           "http://www.neilvandyke.org/racket/mcfly/")
(define mcfly-author       "Neil Van Dyke")
(define repositories       '("4.x"))
(define categories         '(devtools))
(define can-be-loaded-with 'all)
(define primary-file       "main.rkt")
(define mcfly-start        "doc.rkt")
(define scribblings        '(("mcfly.scrbl" () (experimental))))
(define compile-omit-files '("test-mcfly-spec.rkt"))
(define mcfly-files        '(defaults
                              "doc.rkt"
                              "mcfly-expand.rkt"
                              "mcfly-format.rkt"
                              "mcfly-misc.rkt"
                              "mcfly-parse.rkt"
                              "mcfly-scribble.rkt"
                              "mcfly-spec.rkt"
                              "test-mcfly-spec.rkt"))
(define mcfly-license      "LGPLv3")
(define deps               '("at-exp-lib"
                             "base"
                             "scribble-lib"
                             "racket-doc"))

(define mcfly-legal
  "Copyright 2012, 2016 Neil Van Dyke.  This program is Free Software; you can
   redistribute it and/or modify it under the terms of the GNU Lesser General
   Public License as published by the Free Software Foundation; either version
   3 of the License,or (at your option) any later version.  This program is
   distributed in the hope that it will be useful, but without any warranty;
   without even the implied warranty of merchantability or fitness for a
   particular purpose.  See http://www.gnu.org/licenses/ for details.  For
   other licenses and consulting, please contact the author.")
