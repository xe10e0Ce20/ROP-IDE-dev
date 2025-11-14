import js
import json
import re
from lark import Lark, Transformer
from typing import Any, Dict, cast
import uuid

def compile_to_bytecode(source_code, libraries_js_proxy):
    """
    这是您需要编写的核心函数。
    它接收JS传来的源代码、库文件(JS Proxy)和地址。
    """
    try:
        # 1. 将JS对象转换为Python字典
        libraries_dict = libraries_js_proxy.to_py()
        
        # -----------------------------------------------
        # --- [ 在这里替换为您自己的字节码转换逻辑 ] ---
        # -----------------------------------------------
        
        config_grammar = r"""
            ?start: config_program

            config_program: (ggt_def | spf_def | cpf_def)*

            ggt_def: GGT_NAME "{" brace_block "}"
            spf_def: SPF_NAME "(" params ")" "{" brace_block "}"
            cpf_def: CPF_NAME "(" params ")" "{%%BODY%%}" "{" brace_block "}"


            brace_block: (brace_block_nested | ANY_CHAR)+
            brace_block_nested: "{" brace_block "}"
            param: CNAME ("=" ANY_STRING)?
            params: [param ("," param)*]

            
            //终结符
            GGT_NAME: /\$[^ \t\r\n(]+/
            SPF_NAME: /\*[^ \t\r\n(]+/
            CPF_NAME: /![^ \t\r\n(]+/
            ANY_STRING: /[^,)]+/
            ANY_CHAR: /[^\{\}]+/
            
            COMMENT: /(\/\/|;)[^\n]*/
            // --- 导入和忽略 ---
            %import common.CNAME 
            %import common.NEWLINE 
            %import common.WS
            %ignore WS          // 忽略空格
            %ignore NEWLINE     // 忽略空行
            %ignore COMMENT
            
        """


        class ConfigTransformer(Transformer):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.ggt = {}
                self.spf = {}
                self.cpf = {}


            # ggt_def 处理器：直接更新 ggt_dict
            def ggt_def(self, items):
                name = items[0]
                data = items[1]
                self.ggt[name] = data
                return None

            # spf_def 处理器：直接更新 spf_dict
            def spf_def(self, items):
                name = items[0]
                params = items[1]
                body = items[2]
                self.spf[name] = {'params': params, 'body': body}
                return None
            
            # cpf_def 处理器：直接更新 cpf_dict
            def cpf_def(self, items):
                name = items[0]
                params = items[1]
                body = items[2]
                self.cpf[name] = {'params': params, 'body': body}
                return None
                
            
            def brace_block(self, items): return "".join(items)
            def brace_block_nested(self, token): return f"{{ {token[0]} }}"
            def param(self, items): return (items[0], items[1]) if len(items) > 1 else (items[0], None)
            def params(self, items): return items
            
            def GGT_NAME(self, token): return token.value
            def SPF_NAME(self, token): return token.value
            def CPF_NAME(self, token): return token.value
            def CNAME(self, token): return token.value
            def ANY_STRING(self, token): return token.value
            def ANY_CHAR(self, token): return token.value

            def config_program(self, items):
                return {
                    "ggt": self.ggt,
                    "spf": self.spf,
                    "cpf": self.cpf,
                }
            
        config_parser = Lark(config_grammar, start='config_program', parser='lalr',transformer=ConfigTransformer())


        pre_grammar = r"""
            ?start: pre_program

            pre_program: (import_stmt | ggt_def | spf_def | cpf_def | block)*

            import_stmt: "import" FILE_NAME
            ggt_def: "def" GGT_NAME "{" brace_block "}"
            spf_def: "def" SPF_NAME "(" params ")" "{" brace_block "}"
            cpf_def: "def" CPF_NAME "(" params ")" "{%%BODY%%}" "{" brace_block "}"

            block: "@block" "." CNAME ":" BLOCK_CONTENT "@blockend" | "@block" "." CNAME ":" BLOCK_CONTENT "@end"

            brace_block: (brace_block_nested | ANY_CHAR)+
            brace_block_nested: "{" brace_block "}"
            params: [param ("," param)*]
            param: CNAME ("=" ANY_STRING)?

            COMMENT: /(\/\/|;)[^\n]*/
            //终结符
            BLOCK_CONTENT: /(.|\n)+?(?=@blockend)/ | /(.|\n)+?(?=@end)/
            GGT_NAME: /\$[^ \t\r\n(]+/
            SPF_NAME: /\*[^ \t\r\n(]+/
            CPF_NAME: /![^ \t\r\n(]+/
            FILE_NAME: /[a-zA-Z0-9_\-.]+/
            ANY_STRING: /[^,)]+/
            ANY_CHAR: /[^\{\}]+/

            
            %ignore COMMENT
            // --- 导入和忽略 ---
            %import common.CNAME 
            %import common.NEWLINE 
            %import common.WS
            %ignore WS          // 忽略空格
            %ignore NEWLINE     // 忽略空行
        """



        class PreTransformer(Transformer):
            def __init__(self):
                super().__init__()
                self.ggt = {}
                self.spf = {}
                self.cpf = {}
                self.blocks = {}


            # import 语句处理器
            def import_stmt(self, token):
                self._load_module(token[0])
                return None

            # ggt_def 处理器：直接更新 ggt_dict
            def ggt_def(self, items):
                name = items[0]
                data = items[1]
                self.ggt[name] = data
                return None

            # spf_def 处理器：直接更新 spf_dict
            def spf_def(self, items):
                name = items[0]
                params = items[1]
                body = items[2]
                self.spf[name] = {'params': params, 'body': body}
                return None
            
            # cpf_def 处理器：直接更新 cpf_dict
            def cpf_def(self, items):
                name = items[0]
                params = items[1]
                body = items[2]
                self.cpf[name] = {'params': params, 'body': body}
                return None
                
            def block(self, items): 
                name = items[0]
                body = items[1]
                self.blocks[name] = body
                return None
            
            def brace_block(self, items): return "".join(items)
            def brace_block_nested(self, token): return f"{{ {token[0]} }}"
            def params(self, items): return items
            def param(self, items): return (items[0], items[1]) if len(items) > 1 else (items[0], None)
            
            def GGT_NAME(self, token): return token.value
            def SPF_NAME(self, token): return token.value
            def CPF_NAME(self, token): return token.value
            def CNAME(self, token): return token.value
            def ANY_STRING(self, token): return token.value
            def FILE_NAME(self, token): return token.value
            def ANY_CHAR(self, token): return token.value
            def BLOCK_CONTENT(self, token): return token.value



            def pre_program(self, items):
                return {
                    "ggt": self.ggt,
                    "spf": self.spf,
                    "cpf": self.cpf,
                    "blocks": self.blocks
                }
            # --- 辅助方法和基本规则 ---

            def _load_module(self, filename):
                file_content = None
                try:
                    file_content = libraries_dict[filename]
                    config = cast(dict,config_parser.parse(file_content))
                    self.ggt.update(config["ggt"])
                    self.spf.update(config["spf"])
                    self.cpf.update(config["cpf"])
                    print(f"Successfully loaded module '{filename}'")
                except Exception as e:
                    print(f"Error loading module '{filename}': {e}")






        #=======================================preprocess end=========================================
            

        func_grammar = r"""
            ?start: func_program

            func_program: (HEX_DATA | ggt_call | spf_call | cpf_call |ANY_CHAR)*

            ggt_call: GGT_NAME
            spf_call: SPF_NAME "(" params ")"
            cpf_call: CPF_NAME "(" params ")" "{" brace_block "}"


            brace_block: (brace_block_nested | ANY_CHAR | ggt_call | spf_call | cpf_call)+
            brace_block_nested: "{" brace_block "}"
            param: ANY_STRING
            params: [param ("," param)*]

            COMMENT: /(\/\/|;)[^\n]*/
            
            //终结符
            HEX_DATA: /[0-9a-fA-FxX]{2}/
            GGT_NAME: /\$[^ \t\r\n(]+/
            SPF_NAME: /\*[^ \t\r\n(]+/
            CPF_NAME: /![^ \t\r\n(]+/
            ANY_STRING: /[^,)]+/
            ANY_CHAR: /[^\$\*!\{\}]+/

            %ignore COMMENT
            // --- 导入和忽略 ---
            %import common.CNAME 
            %import common.NEWLINE 
            %import common.WS
            %ignore WS          // 忽略空格
            %ignore NEWLINE     // 忽略空行
        """

        class FuncTransformer(Transformer):
            def __init__(self, ggt, spf, cpf):
                self.ggt = ggt
                self.spf = spf
                self.cpf = cpf
                super().__init__()
            
            def ggt_call(self, token):
                name = token[0]
                self.ggt
                try:
                    ggt_value = self.ggt[name]
                except KeyError:
                    raise Exception(f"Undefined function: {name}")
                return ggt_value

            def spf_call(self, items):
                name = items[0]
                params = items[1]
                params = [item for item in params if item is not None]
                try:
                    def_params = self.spf[name]['params']
                    def_params = [item for item in def_params if item is not None]
                    def_body = self.spf[name]['body']
                except KeyError:
                    raise Exception(f"Undefined function: {name}")
                
                #将形参映射到实参
                param_dict = {}
                for i in range(len(def_params)):
                    try:
                        param_dict[def_params[i][0]] = params[i]
                    except IndexError:
                        if def_params[i][1] is not None:
                            param_dict[def_params[i][0]] = def_params[i][1]
                        else:
                            raise Exception(f"Not enough parameters for function: {name}")

                #检测模板中%_xxx_%，并将实参替换到模板中  
                for name in param_dict:
                    pattern = r'%\_' + re.escape(name) + r'\_%'
                    def_body = re.sub(pattern, param_dict[name], def_body)


                #检测模板中&_xxx_&，并生成唯一标识符
                uuid_map = {}
                pattern = r'&_(\S+)_&'
                def replacer(match):
                    matched_content = match.group(1)
                    if matched_content in uuid_map:
                        return uuid_map[matched_content]
                    else:
                        unique_id = str(uuid.uuid4())[:8]
                        new_value = f"{matched_content}_{unique_id}"
                        uuid_map[matched_content] = new_value
                        return new_value
                    
                def_body = re.sub(pattern, replacer, def_body)

                return def_body




            def cpf_call(self, items):
                name = items[0]
                params = items[1]
                params = [item for item in params if item is not None]
                body = items[2]
                try:
                    def_params = self.cpf[name]['params']
                    def_params = [item for item in def_params if item is not None]
                    def_body = self.cpf[name]['body']
                except KeyError:
                    raise Exception(f"Undefined function: {name}")
                
                #将形参映射到实参
                param_dict = {}
                for i in range(len(def_params)):
                    try:
                        param_dict[def_params[i][0]] = params[i]
                    except IndexError:
                        if def_params[i][1] is not None:
                            param_dict[def_params[i][0]] = def_params[i][1]
                        else:
                            raise Exception(f"Not enough parameters for function: {name}")

                #检测模板中%_xxx_%，并将实参替换到模板中  
                for name in param_dict:
                    pattern = r'%\_' + re.escape(name) + r'\_%'
                    def_body = re.sub(pattern, param_dict[name], def_body)


                #检测模板中&_xxx_&，并生成唯一标识符
                uuid_map = {}
                pattern = r'&_(\S+)_&'
                def replacer(match):
                    matched_content = match.group(1)
                    if matched_content in uuid_map:
                        return uuid_map[matched_content]
                    else:
                        unique_id = str(uuid.uuid4())[:8]
                        new_value = f"{matched_content}_{unique_id}"
                        uuid_map[matched_content] = new_value
                        return new_value
                    
                def_body = re.sub(pattern, replacer, def_body)
                    
                #替换模板中的%%BODY%%
                def_body = def_body.replace(r"%%BODY%%", body)
                
                return def_body
            


            def brace_block(self, items): return "".join(items)
            def brace_block_nested(self, token): return f"{{ {token[0]} }}"
            def param(self, token): return token[0]
            def params(self, items): return items


            def HEX_DATA(self, token): return token.value
            def GGT_NAME(self, token): return token.value
            def SPF_NAME(self, token): return token.value
            def CPF_NAME(self, token): return token.value
            def CNAME(self, token): return token.value
            def ANY_STRING(self, token): return token.value
            def ANY_CHAR(self, token): return token.value

            
            #返回处理后的代码
            def func_program(self, items):
                return "".join(items)


        pass1_grammar = r"""
            start: (expr | offset_def | x_def | label_def | rstoffst)*
            ?expr: term (( PLUS | MINUS ) term)*
            ?term: factor+
            ?factor: brackets | swap_endian | hex | LABEL_CALL | LABEL_CALL_RAW | overwrite
            swap_endian: "[" expr "]" 
            ?brackets: "<" expr ">"

            overwrite: "@overwrite" "(" ANY_STRING "," ANY_STRING ")"

            offset_def: "@offset" "=" FOUR_BYTE
            rstoffst: "@rstoffst"
            x_def: "@x" "=" HALF_BYTE
            label_def: "@adr" "." CNAME

            PLUS: "+"
            MINUS: "-"

            FOUR_BYTE: /[0-9a-fA-F]{4}/
            HALF_BYTE: /[0-9a-fA-F]/
            hex: HEX_DATA+
            ANY_STRING: /[^,)]+/
            
            LABEL_CALL: /#[a-zA-Z_][a-zA-Z0-9_]*/
            LABEL_CALL_RAW: /##[a-zA-Z_][a-zA-Z0-9_]*/
            HEX_DATA: /[0-9a-fA-FxX]{2}/

            COMMENT: /(\/\/|;)[^\n]*/


            %ignore COMMENT    
            %import common.CNAME
            %import common.WS
            %ignore WS
        """


        #将地址标签全都替换成0x0000，并解析算式，排除其它符号，方便后续计算地址
        class Pass1Transformer(Transformer):
            def __init__(self):
                super().__init__()

            def factor(self, token):
                return token
            def brackets(self, items):
                return items[0]
            def term(self, items):
                return "".join(items)
            
            def hex(self, items):
                return "".join(items)
            def overwrite(self, items):
                return ""
            def offset_def(self, items):
                return f" @offset={items[0]} "
            def rstoffst(self, token):
                return " @rstoffst "
            def x_def(self, items):
                return ""
            
            def swap_endian(self, token):
                return self._swap_endian(token[0])
            def expr(self, items):
                max_width = self._get_max_width(items)
                result_int = int(items[0], 16)
                if len(items) == 1: return items[0]
                for i in range(2, len(items), 2):
                    op = items[i-1]
                    value = items[i]
                    int_value = int(value, 16)
                    if op == "+":
                        result_int += int_value
                    elif op == "-":
                        result_int -= int_value
                        max_value = 16**max_width
                        if result_int < 0:
                            result_int += max_value
                    else:
                        raise Exception(f"Invalid operator: {op}")
                    
                result_str = f"{result_int:0{max_width}X}"
                return result_str
            
            def LABEL_CALL(self, token):
                return "0000"
            
            def LABEL_CALL_RAW(self, token):
                return "0000"
            
            def label_def(self, items):
                return f" @adr.{items[0]} "
            
            def HEX_DATA(self, token):
                hex_string:str = token.value
                hex_string = hex_string.lower()
                hex_string=hex_string.replace(" ", "")
                hex_string = hex_string.replace("x", "0")
                return hex_string

            def ANY_STRING(self, token):
                return token.value
            def FOUR_BYTE(self, token):
                return token.value
            def HALF_BYTE(self, token):
                return token.value
            def PLUS(self, token): return token.value
            def MINUS(self, token): return token.value
            def CNAME(self, token):
                return token.value
            def start(self, items):
                return "".join(items)  

            # 一些辅助函数
            def _swap_endian(self, hex_string: str):
                hex_string = hex_string.replace(" ", "")
                if len(hex_string) % 4 != 0:
                    raise ValueError("Hex string length for endian swap must have even length")
                bytes_list = [hex_string[i:i+2] for i in range(0, len(hex_string), 2)]
                result = []
                for i in range(0, len(bytes_list), 2): # 每两个字节交换位置
                    result.append(bytes_list[i+1])
                    result.append(bytes_list[i])
                return "".join(result)
            
            def _get_max_width(self, items):
                # 计算表达式中所有操作数的最大长度（以字符数为准）。
                max_len = 0
                # items 结构是 [value1, Token('op1'), value2, ...]
                for i in range(0, len(items), 2): # 只遍历操作数 (索引 0, 2, 4, ...)
                    item = items[i]
                    # item 此时是 HEX_DATA 或 expr/term 返回的十六进制字符串
                    width = len(item)
                    if width > max_len:
                        max_len = width
                # 确保宽度是偶数
                return max_len if max_len % 2 == 0 else max_len + 1

        adr_grammar = r"""
            start:(HEX_DATA | label_def | offset_def | rstoffst)*
            label_def: "@adr" "." CNAME
            HEX_DATA: /[0-9a-fA-F]{2}/
            offset_def: "@offset" "=" FOUR_BYTE
            rstoffst: "@rstoffst"
            FOUR_BYTE: /[0-9a-fA-F]{4}/

            COMMENT: /(\/\/|;)[^\n]*/

            %ignore COMMENT
            %import common.CNAME
            %import common.WS
            %ignore WS
        """

        # 解析地址标签
        class AdrTransformer(Transformer):
            def __init__(self):
                self.label_map = {}
                self.byte_count = 0
                self.offset = 0x0000
                super().__init__()

            def HEX_DATA(self, token):
                self.byte_count += len(token.value)/2
                return None
            
            def offset_def(self, items):
                self.offset = int(items[0], 16)
                return None
            def rstoffst(self, token):
                self.byte_count = 0
                return None
            def label_def(self, items):
                label_name = items[0]
                if label_name in self.label_map:
                    raise Exception(f"Label {label_name} already defined")
                label_list = []
                label_list.append(f"{int(self.offset + self.byte_count):04X}")
                label_list.append(f"{int(self.byte_count):04X}")
                self.label_map[label_name] = label_list
                return None
            def CNAME(self, token):
                return token.value
            
            def start(self, items):
                return self.label_map
            

        pass2_grammar = r"""
            start: (expr | offset_def | x_def | label_def | overwrite | rstoffst)*
            ?expr: term (( PLUS | MINUS ) term)*
            ?term: factor+
            ?factor: brackets | swap_endian | hex | LABEL_CALL | LABEL_CALL_RAW
            swap_endian: "[" expr "]" 
            ?brackets: "<" expr ">"

            overwrite: "@overwrite" "(" expr "," expr ")"

            offset_def: "@offset" "=" FOUR_BYTE
            rstoffst: "@rstoffst"
            x_def: "@x" "=" HALF_BYTE
            label_def: "@adr" "." CNAME

            PLUS: "+"
            MINUS: "-"

            FOUR_BYTE: /[0-9a-fA-F]{4}/
            HALF_BYTE: /[0-9a-fA-F]/
            hex: HEX_DATA+
            LABEL_CALL: /#[a-zA-Z_][a-zA-Z0-9_]*/
            LABEL_CALL_RAW: /##[a-zA-Z_][a-zA-Z0-9_]*/
            HEX_DATA: /[0-9a-fA-FxX]{2}/

            
            COMMENT: /(\/\/|;)[^\n]*/

            %ignore COMMENT
            %import common.CNAME
            %import common.WS
            %ignore WS
        """

        class Pass2Transformer(Transformer):
            def __init__(self,label_map):
                self.label_map :dict = label_map
                self.x_placeholder = "0"
                self.overwrite_map = {}
                super().__init__()

            def factor(self, token):
                return token
            def brackets(self, items):
                return items[0]
            def term(self, items):
                return "".join(items)
            
            def hex(self, items):
                return "".join(items)
            def overwrite(self, items):
                self.overwrite_map[items[0]] = items[1]
                return ""
            def offset_def(self, items):
                return ""
            def  rstoffst(self, token):
                return ""
            def x_def(self, items):
                self.x_placeholder = items[0]
                return ""
            
            def swap_endian(self, token):
                return self._swap_endian(token[0])
            def expr(self, items):
                max_width = self._get_max_width(items)
                result_int = int(items[0], 16)
                if len(items) == 1: return items[0]
                for i in range(2, len(items), 2):
                    op = items[i-1]
                    value = items[i]
                    int_value = int(value, 16)
                    if op == "+":
                        result_int += int_value
                    elif op == "-":
                        result_int -= int_value
                        max_value = 16**max_width
                        if result_int < 0:
                            result_int += max_value
                    else:
                        raise Exception(f"Invalid operator: {op}")
                    
                result_str = f"{result_int:0{max_width}X}"
                return result_str
            
            def LABEL_CALL(self, token):
                label_name = token.value[1:]
                label_value = int(self.label_map[label_name][0], 16)
                return f"{label_value:04X}"
            
            def LABEL_CALL_RAW(self, token):
                label_name = token.value[2:]
                label_value = int(self.label_map[label_name][1], 16)
                return f"{label_value:04X}"
            
            def label_def(self, items):
                return ""
            
            def HEX_DATA(self, token):
                hex_string:str = token.value
                hex_string = hex_string.lower()
                hex_string = hex_string.replace(" ", "")
                hex_string = hex_string.replace("x", self.x_placeholder)
                return hex_string

            def ANY_STRING(self, token):
                return token.value
            def FOUR_BYTE(self, token):
                return token.value
            def HALF_BYTE(self, token):
                return token.value
            def PLUS(self, token): return token.value
            def MINUS(self, token): return token.value
            def CNAME(self, token):
                return token.value
            def start(self, items):
                code = "".join(items) 
                overwrite = self.overwrite_map
                return {"code": code, "overwrite": overwrite} 

            # 一些辅助函数
            def _swap_endian(self, hex_string: str):
                hex_string = hex_string.replace(" ", "")
                if len(hex_string) % 4 != 0:
                    raise ValueError("Hex string length for endian swap must have even length")
                bytes_list = [hex_string[i:i+2] for i in range(0, len(hex_string), 2)]
                result = []
                for i in range(0, len(bytes_list), 2): # 每两个字节交换位置
                    result.append(bytes_list[i+1])
                    result.append(bytes_list[i])
                return "".join(result)
            
            def _get_max_width(self, items):
                # 计算表达式中所有操作数的最大长度（以字符数为准）。
                max_len = 0
                # items 结构是 [value1, Token('op1'), value2, ...]
                for i in range(0, len(items), 2): # 只遍历操作数 (索引 0, 2, 4, ...)
                    item = items[i]
                    # item 此时是 HEX_DATA 或 expr/term 返回的十六进制字符串
                    width = len(item)
                    if width > max_len:
                        max_len = width
                # 确保宽度是偶数
                return max_len if max_len % 2 == 0 else max_len + 1
            

        class ROPCompiler():
            def __init__(self):
                self.ggt = {}
                self.spf = {}
                self.cpf = {}
                self.blocks = {}
                self.adr_map = {}

            def PreCompile(self,code):
                pre_parser = Lark(pre_grammar, start='pre_program', parser='lalr',transformer=PreTransformer())
                pre_result= cast(Dict[str, Any], pre_parser.parse(code))
                self.ggt = pre_result['ggt']
                self.spf = pre_result['spf']
                self.cpf = pre_result['cpf']
                self.blocks = pre_result['blocks']
                
            def FuncCompile(self):
                func_parser = Lark(func_grammar, start='func_program', parser='lalr',transformer=FuncTransformer(self.ggt, self.spf, self.cpf))
                for block_name, block in self.blocks.items():
                    last_block = ""
                    while block != last_block:
                        last_block = block
                        block = func_parser.parse(block)
                    self.blocks[block_name] = block


            def AdrCompile(self):
                pass1parser = Lark(pass1_grammar, start='start', parser='lalr',transformer=Pass1Transformer())
                adrparser = Lark(adr_grammar, start='start', parser='lalr',transformer=AdrTransformer())
                for block_name, block in self.blocks.items():
                    adr_block = pass1parser.parse(self.blocks[block_name])
                    self.adr_map.update(cast(dict, adrparser.parse(adr_block)))
            
            def Pass2Compile(self):
                pass2parser = Lark(pass2_grammar, start='start', parser='lalr',transformer=Pass2Transformer(self.adr_map))

                for block_name, block in self.blocks.items():
                    overwrite_map = {}
                    result = cast(dict, pass2parser.parse(block))
                    self.blocks[block_name] = result["code"]
                    # 解析overwrite
                    overwrite_map.update(result["overwrite"])
                    for addr, value in overwrite_map.items():
                        pos = int(addr, 16)
                        pos = pos*2 - 2
                        if pos >= len(self.blocks[block_name]):
                            raise Exception(f"Overwrite address out of range: {addr}")
                        
                        self.blocks[block_name] = self.blocks[block_name][:pos+2] + value + self.blocks[block_name][pos+len(value)+2:]


            def Compile (self):
                code = source_code
                self.PreCompile(code)
                self.FuncCompile()
                self.AdrCompile()
                self.Pass2Compile()

                return self.blocks
        
        # -----------------------------------------------
        # --- [ 您的逻辑结束 ] ---
        # -----------------------------------------------
        
        compiler = ROPCompiler()
        items = compiler.Compile()
        for item in items:
            items[item] = items[item].upper()
        return items

    except Exception as e:
        # 将Python错误返回给JS
        js.console.error(f"Python 编译时出错: {e}")
        return {"error": f"error: {e}"}

# 2. 将Python函数暴露给JS，以便JS的 "编译" 按钮可以调用它
js.globalThis.pyProcessCode = compile_to_bytecode