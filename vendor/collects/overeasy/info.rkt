#lang setup/infotab

(define mcfly-planet          'neil/overeasy:4:3)
(define name                  "Overeasy")
(define mcfly-subtitle        "Racket Language Test Engine")
(define blurb                 (list name ": " mcfly-subtitle))
(define mcfly-author          "Neil Van Dyke")
(define categories            '(devtools))
(define homepage              "http://www.neilvandyke.org/racket/overeasy/")
(define scribblings           '(("overeasy.scrbl" () ("Testing"))))
(define primary-file          "main.rkt")
(define can-be-loaded-with    'all)
(define required-core-version "5.3.1")
(define repositories          '("4.x"))
(define mcfly-files           '(defaults
                                 "overeasy.rkt"
                                 "test-overeasy.rkt"))
(define mcfly-start           "overeasy.rkt")
(define mcfly-license         "LGPLv3")
(define deps                  '("base"
                                "racket-doc"
                                "scribble-lib"
                                "mcfly"))

(define mcfly-legal
  "Copyright 2011, 2012, 2015, 2016, 2023 Neil Van Dyke.  This program is Free
Software; you can redistribute it and/or modify it under the terms of the GNU
Lesser General Public License as published by the Free Software Foundation;
either version 3 of the License, or (at your option) any later version.  This
program is distributed in the hope that it will be useful, but without any
warranty; without even the implied warranty of merchantability or fitness for a
particular purpose.  See http://www.gnu.org/licenses/ for details.  For other
licenses and consulting, please contact the author.")
