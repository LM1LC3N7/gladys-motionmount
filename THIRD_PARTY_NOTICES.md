# Third-party notices

This integration ports to JavaScript the knowledge of the local protocol of
the Vogel's MotionMount held by the following project: the TCP line protocol
(`key` to read, `key = value` to write, the `#<code>` answers), the keys used
here (`mac`, `configuration/name`, `mount/extension/current`,
`mount/turn/current`, `mount/isMoving`, `mount/errorStatus`,
`configuration/authentication/status`, `configuration/authentication/pin`,
`mount/preset/index`, `mount/preset/position`, `mount/preset/<n>/active`,
`name`, `extension`, `turn`), the value forms, the encoding of a position
(unsigned 16-bit extension and signed 16-bit turn, big endian, in hex), the
meaning of the authentication status byte and the aggregation of the error
status. No file is copied, and nothing of it is installed at runtime.

## python-MotionMount

<https://github.com/vogelsproducts/python-MotionMount> (main branch, commit
94fb316 of 2025-02-27; version 2.3.1), by Vogel's Products, the library of the
MotionMount integration of Home Assistant. Its `LICENSE.txt` file:

```
MIT License

Copyright (c) 2023 Vogel's Products

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
