# ROP_Compiler

一款用于 **nx-u16** 及 **nx-u8** 系列芯片的 ROP 链编译工具，支持 gadgets、自定义函数 和 地址标签。


## 目录
- [ROP_Compiler](#rop_compiler)
  - [一、语法说明](#一语法说明)
    - [1.1 导入配置](#11-导入配置)
    - [1.2 函数和 Gadgets 定义](#12-函数和-gadgets-定义)
    - [1.3 程序块](#13-程序块)
    - [1.4 字节码](#14-字节码)
      - [字节码运算](#字节码运算)
    - [1.5 Gadgets](#15-gadgets)
    - [1.6 简单函数](#16-简单函数)
    - [1.7 高阶函数](#17-高阶函数)
    - [1.8 偏移量声明](#18-偏移量声明)
    - [1.9 占位符声明](#19-占位符声明)
    - [1.10 地址标签（重要）](#110-地址标签重要)
    - [1.11 注释](#111-注释)
    - [1.12 覆写](#112-覆写)
  - [二、配置文件语法](#二配置文件语法)
    - [2.1 Gadgets](#21-gadgets)
    - [2.2 简单函数](#22-简单函数)
    - [2.3 高阶函数](#23-高阶函数)
  - [三、Gadgets、函数规范](#三gadgets函数规范)
    - [3.1 Gadgets 命名](#31-gadgets-命名)
    - [3.2 函数传参规范（重要）](#32-函数传参规范重要)


## 一、语法说明
### 1.1 导入配置
在文件开头使用 `import <文件名>` 导入配置文件。程序将读取配置文件中的 gadgets、简单函数 和 高阶函数。  
示例：
```
import verc.ggt
```

### 1.2 函数和 Gadgets 定义
使用 `def ...` 关键字定义函数，语法与配置文件中相同，但在头部需要加上 `def`。

### 1.3 程序块
使用 `@block.xxx:` 开始一个程序块（`xxx` 为任意变量名），并使用 `@blockend` 结束。  
示例：
```
@block.main:
    // 程序内容...
@blockend
```

### 1.4 字节码
直接输入字节码，无需前缀，自动忽略大小写及空格。可以使用 `x` 作为占位符。  
示例：
```
0123 abcd
a821x1xx // x 为占位符
```

#### 字节码运算
- **加减运算**: 使用 `+` 或 `-` 运算符。建议运算符两侧保留空格。
  - 运算结果的位数以参与运算中位数最大者为准。
  - 负数返回补码。
  - 示例：`a821 + 01 - a800  // 返回 0022`

- **尖括号 `<...>` 的使用**: 用于优先运算或将一段字节码合并为整体。
  - 示例：`a821 - <02 - 01>  // 先算 02 - 01 = 01，最终返回 a820`；`<02 04>  // 返回 0204 (用于明确边界)`

- **方括号 `[...]` 的使用**: 包裹一段字节码，使其每两字节进行大小端转换。
  - 示例：`[02 04]  // 返回 0402`；`[ 01 23 45 67 ]  // 返回 67452301`

### 1.5 Gadgets
Gadgets 统一前缀为 `$`。Gadgets 本质上等效于一段字节码。  
示例：
```
$er0= // 等效于 a821x1xx 等一段字节码
```
命名规范: 支持除了空格和左括号以外的任意字符。

### 1.6 简单函数
简单函数统一前缀为 `*`。  
示例：
```
*print (xxxx, xx)
```

### 1.7 高阶函数
高阶函数统一前缀为 `!`。  
示例：
```
!loop (xxxx, xxxx){
    // 这里是函数体，可以自由编写
}
```

### 1.8 偏移量声明
使用 `@offset= xxxx` 声明偏移量。  
**重要说明**: 在调用依赖地址标签的函数时，务必填入程序运行区域的真实起始地址。偏移量可以在程序块内随时重新声明。  
示例：
```
@offset= d710
```

### 1.9 占位符声明
使用 `@x= x`（`x` 是任意十六进制数字）声明占位符，这时字节码中的 `x` 会被替换为该值。占位符也可以在一个程序块内随时重新声明。  
示例：
```
@x=0
```

### 1.10 地址标签（重要）
- 使用 `@adr.xxx` 标记一个地址位置。
- 使用 `#xxx` 调用这个 双字节地址（大端，会加上当前偏移量）。
- 使用 `##xxx` 返回 没有偏移量的地址。

示例：
```
@block.main:
   @x=0
   @offset= d710
   
   @adr.start
   00 00 00 00
   @adr.end
   @offset= e9e0
   @adr.end_2
   #start  // 返回 d710
   ##start // 返回 0000
   #end    // 返回 d714
   ##end   // 返回 0004
   #end_2  // 返回 e9e4
   ##end_2   // 返回 0004
@blockend
```
> 地址标签可以在程序块之间互通。

### 1.11 注释
每一行中 `//` 之后的部分即为注释。

### 1.12 覆写
使用 `@overwrite (地址, 字节码)` 在指定地址处覆写字节码。
- 地址和字节码都支持表达式。
- 地址是 大端 且 不含偏移量 的地址。
- `@overwrite` 必须在相应程序块内部。


## 二、配置文件语法
### 2.1 Gadgets
```
$name {value}
```
程序中的 `$name` 将被替换成 `value`，`value` 的字节长度不限。

### 2.2 简单函数
```
*name (arg0(=defaultvalue?), arg1......){
    body
}
```

### 2.3 高阶函数
```
!name (arg0(=defaultvalue?), ......){%%BODY%%}{
   ...... // 函数定义体
}
```

在函数体中：
- 使用 `%_arg_%` 访问参数。
- 如果要使用地址标签，必须使用作用域限制（以 `&_..._&` 包裹标签名），以避免与外界标签冲突：
  ```
  @adr.&_xxx_&
  #&_xxx_&
  ##&_xxx_&
  ```

示例 (简单函数定义):
```
*function (arg0, arg1=0000){
    $xr0= [%_arg0_%][%_arg1_%]
    @adr.&_a_&
    #&_a_&
}
```

示例 (调用):
```
*function (1234)  // arg1 有默认值，可省略
```


## 三、Gadgets、函数规范
### 3.1 Gadgets 命名
- 如果 Gadgets 最后会 pop 寄存器，则在 `&` 后面加上对应的编码 (如 `x4q8`)。
- 如果伴随 其它效果，则在前面加上问号 (如 `?`)。
  - 示例: `wait_key` 伴随 `mov sp, er14; pop xr4; pop qr8`，则命名为 `$?waitkeyto[er8]&x4q8`。
- 如果函数或 Gadgets 依赖 RT 返回，则在末尾增加 `?`。

### 3.2 函数传参规范（重要）
函数传参统一使用 **>>>大端<<<**。因此，调用简单函数或高阶函数时，请勿传入小端值。


# ROP_Compiler
A ROP chain compilation tool for nx-u16 and nx-u8 series chips, supporting gadgets, custom functions, and address labels.


## Table of Contents
- [ROP_Compiler](#rop_compiler-1)
  - [I. Syntax Description](#i-syntax-description)
    - [1.1 Import Configuration](#11-import-configuration)
    - [1.2 Function and Gadget Definition](#12-function-and-gadget-definition)
    - [1.3 Program Block](#13-program-block)
    - [1.4 Bytecode](#14-bytecode)
      - [Bytecode Operations](#bytecode-operations)
    - [1.5 Gadgets](#15-gadgets)
    - [1.6 Simple Functions](#16-simple-functions)
    - [1.7 High-Order Functions](#17-high-order-functions)
    - [1.8 Offset Declaration](#18-offset-declaration)
    - [1.9 Placeholder Declaration](#19-placeholder-declaration)
    - [1.10 Address Label (Important)](#110-address-label-important)
    - [1.11 Comments](#111-comments)
    - [1.12 Overwrite](#112-overwrite)
  - [II. Configuration File Syntax](#ii-configuration-file-syntax)
    - [2.1 Gadgets](#21-gadgets-1)
    - [2.2 Simple Functions](#22-simple-functions-1)
    - [2.3 High-Order Functions](#23-high-order-functions-1)
  - [III. Gadgets and Function Specifications](#iii-gadgets-and-function-specifications)
    - [3.1 Gadget Naming](#31-gadget-naming)
    - [3.2 Function Parameter Passing Specification (Important)](#32-function-parameter-passing-specification-important)


## I. Syntax Description
### 1.1 Import Configuration
Add `import <filename>` at the beginning of the file to import the configuration file. The program will read gadgets, simple functions, and high-order functions from it.  
Example:
```
import verc.ggt
```

### 1.2 Function and Gadget Definition
Use `def ...` to define a function. The syntax is the same as in the configuration file, but with `def` added to the header.

### 1.3 Program Block
Start a program block with `@block.xxx:` (xxx is any variable name) and end it with `@blockend`.  
Example:
```
@block.main:
    // Program code...
@blockend
```

### 1.4 Bytecode
Enter bytecode directly without a prefix. Case and spaces are automatically ignored. You can use `x` as the placeholder.  
Example:
```
0123 abcd
a821x1xx // x is the placeholder
```

#### Bytecode Operations
- **Addition and Subtraction**: Use the `+` or `-` operators. It's best to have spaces around the operators.
  - The resulting bit width is the maximum width of the participating bytecodes.
  - Negative results return the two's complement.
  - Example: `a821 + 01 - a800  // Returns 0022`

- **Use of Angle Brackets `<...>`**: Used to prioritize an expression or to combine a segment of bytecode into a whole.
  - Example: `a821 - <02 - 01>  // 02 - 01 is computed first, returns 01, final result is a820`; `<02 04>  // Returns 0204 (Used to clarify boundaries)`

- **Use of Square Brackets `[...]`**: Enclose a segment of bytecode to perform endian swap on every two bytes (word-wise).
  - Example: `[02 04]  // Returns 0402`; `[ 01 23 45 67 ]  // Returns 67452301`

### 1.5 Gadgets
Gadgets are uniformly prefixed with `$`. A gadget is essentially equivalent to a segment of bytecode.  
Example:
```
$er0= // Equivalent to a segment of bytecode like a821x1xx
```
Naming: Supports any characters except space and left parenthesis.

### 1.6 Simple Functions
Simple functions are uniformly prefixed with `*`.  
Example:
```
*print (xxxx, xx)
```

### 1.7 High-Order Functions
High-order functions are uniformly prefixed with `!`.  
Example:
```
!loop (xxxx, xxxx){
    // This is the function body, you can write freely
}
```

### 1.8 Offset Declaration
Use `@offset= xxxx` to declare an offset.  
**Important**: When calling simple or high-order functions that rely on address labels, be sure to provide the real starting address of the program execution area. The offset can be re-declared at any time within a program block.  
Example:
```
@offset= d710
```

### 1.9 Placeholder Declaration
Use `@x= x` (x is any hexadecimal digit) to declare a placeholder. The `x` in the bytecode will then be replaced by this value. The placeholder can also be re-declared at any time within a program block.  
Example:
```
@x=0
```

### 1.10 Address Label (Important)
- Use `@adr.xxx` to mark an address location.
- Use `#xxx` to call this two-byte address (Big-endian, with the current offset added).
- Use `##xxx` to return the address without the offset.

Example:
```
@block.main:
   @x=0
   @offset= d710
   
   @adr.start
   00 00 00 00
   @adr.end
   @offset= e9e0
   @adr.end_2
   #start  // Returns d710
   ##start // Returns 0000
   #end    // Returns d714
   ##end   // Returns 0004
   #end_2  // Returns e9e4
   ##end_2   // Returns 0004
@blockend
```
> Address labels are shared across program blocks.

### 1.11 Comments
The part of a line after `//` is a comment.

### 1.12 Overwrite
Use `@overwrite (address, bytecode)` to overwrite bytecode at a specified address. The length of the bytecode is not limited, unless it exceeds the boundary.
- Both address and bytecode support expressions.
- The address must be Big-endian and without offset.
- `@overwrite` must be inside the corresponding program block.


## II. Configuration File Syntax
### 2.1 Gadgets
```
$name {value}
```
`$name` in the program will be replaced by `value`.

### 2.2 Simple Functions
```
*name (arg0(=defaultvalue?), arg1......){
    body
}
```

### 2.3 High-Order Functions
```
!name (arg0(=defaultvalue?), ......){%%BODY%%}{
   ...... // Function definition body
}
```

In the function body:
- Use `%_arg_%` to access arguments.
- If address labels are used, they must be scoped (by enclosing the label name in `&_..._&`) to prevent conflicts with external labels:
  ```
  @adr.&_xxx_&
  #&_xxx_&
  ##&_xxx_&
  ```

Example (Simple Function Definition):
```
*function (arg0, arg1=0000){
    $xr0= [%_arg0_%][%_arg1_%]
    @adr.&_a_&
    #&_a_&
}
```

Example (Call):
```
*function (1234)  // arg1 has a default value and can be omitted
```


## III. Gadgets and Function Specifications
### 3.1 Gadget Naming
- If the gadget ends with a register pop, append the corresponding encoding after `&` (e.g., `x4q8`).
- If it has other effects, prepend a question mark (e.g., `?`).
  - Example: `wait_key` is accompanied by `mov sp, er14; pop xr4; pop qr8`, so it is named `$?waitkeyto[er8]&x4q8`.
- If a function or gadget relies on an RT return, append `?` at the end.

### 3.2 Function Parameter Passing Specification (Important)
Function parameters must be passed using **>>>Big-endian<<<**. Therefore, do not pass little-endian values when calling simple or high-order functions.