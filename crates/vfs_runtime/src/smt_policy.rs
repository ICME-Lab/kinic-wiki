// Where: crates/vfs_runtime/src/smt_policy.rs
// What: Restricted SMT-LIB policy parser, normalizer, and evaluator.
// Why: Uploaded read policies need deterministic validation and deny-by-default evaluation.
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use sha2::{Digest, Sha256};

pub const SMT_POLICY_HASH_BYTES: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SmtPolicyLimits {
    pub max_bytes: usize,
    pub max_ast_nodes: usize,
    pub max_assertions: usize,
    pub max_symbols: usize,
    pub max_evaluator_fuel: usize,
}

impl Default for SmtPolicyLimits {
    fn default() -> Self {
        Self {
            max_bytes: 64 * 1024,
            max_ast_nodes: 4096,
            max_assertions: 128,
            max_symbols: 256,
            max_evaluator_fuel: 4096,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SmtPolicyError {
    Parse(String),
    Unsupported(String),
    Invalid(String),
    Limit(String),
}

impl fmt::Display for SmtPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(message) => write!(formatter, "parse error: {message}"),
            Self::Unsupported(message) => write!(formatter, "unsupported SMT-LIB: {message}"),
            Self::Invalid(message) => write!(formatter, "invalid SMT policy: {message}"),
            Self::Limit(message) => write!(formatter, "SMT policy limit exceeded: {message}"),
        }
    }
}

impl std::error::Error for SmtPolicyError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FactValue {
    Bool(bool),
    Scalar(String),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ActionFacts {
    values: BTreeMap<String, FactValue>,
}

impl ActionFacts {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert_bool(&mut self, name: impl Into<String>, value: bool) {
        self.values.insert(name.into(), FactValue::Bool(value));
    }

    pub fn insert_scalar(&mut self, name: impl Into<String>, value: impl Into<String>) {
        self.values
            .insert(name.into(), FactValue::Scalar(value.into()));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyDecision {
    Allow,
    Deny,
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SmtPolicy {
    declarations: BTreeMap<String, Sort>,
    definitions: Vec<Definition>,
    definitions_by_name: BTreeMap<String, usize>,
    assertions: Vec<BoolExpr>,
    normalized_hash: [u8; SMT_POLICY_HASH_BYTES],
    max_evaluator_fuel: usize,
}

impl SmtPolicy {
    pub fn normalized_hash(&self) -> [u8; SMT_POLICY_HASH_BYTES] {
        self.normalized_hash
    }

    pub fn normalized_hash_hex(&self) -> String {
        self.normalized_hash
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    pub fn assertion_count(&self) -> usize {
        self.assertions.len()
    }

    pub fn evaluate(&self, facts: &ActionFacts) -> PolicyDecision {
        let mut evaluator = Evaluator {
            policy: self,
            facts,
            fuel: self.max_evaluator_fuel,
        };

        for assertion in &self.assertions {
            match evaluator.eval_bool(assertion) {
                EvalOutcome::Known(true) => {}
                EvalOutcome::Known(false) => return PolicyDecision::Deny,
                EvalOutcome::Unknown | EvalOutcome::FuelExhausted => {
                    return PolicyDecision::Blocked;
                }
            }
        }

        PolicyDecision::Allow
    }

    fn canonical_bytes(&self) -> Vec<u8> {
        let mut output = String::from("smt-policy-v1\n");

        for (name, sort) in &self.declarations {
            output.push_str("declare ");
            output.push_str(&canonical_symbol(name));
            output.push(' ');
            output.push_str(&sort.canonical());
            output.push('\n');
        }

        for definition in &self.definitions {
            output.push_str("define ");
            output.push_str(&canonical_symbol(&definition.name));
            output.push(' ');
            output.push_str(&definition.sort.canonical());
            output.push(' ');
            match &definition.body {
                DefinitionBody::Bool(body) => output.push_str(&body.canonical()),
                DefinitionBody::Scalar(body) => output.push_str(&body.canonical()),
            }
            output.push('\n');
        }

        for assertion in &self.assertions {
            output.push_str("assert ");
            output.push_str(&assertion.canonical());
            output.push('\n');
        }

        output.into_bytes()
    }
}

pub fn parse_smt_policy(text: &str) -> Result<SmtPolicy, SmtPolicyError> {
    parse_smt_policy_with_limits(text, SmtPolicyLimits::default())
}

pub fn parse_smt_policy_with_limits(
    text: &str,
    limits: SmtPolicyLimits,
) -> Result<SmtPolicy, SmtPolicyError> {
    if text.len() > limits.max_bytes {
        return Err(SmtPolicyError::Limit(format!(
            "max_bytes {} < policy bytes {}",
            limits.max_bytes,
            text.len()
        )));
    }

    let tokens = Lexer::new(text).tokenize()?;
    let sexprs = SExprParser::new(tokens, limits.max_ast_nodes).parse_all()?;
    let mut builder = PolicyBuilder::new(limits);

    for sexpr in &sexprs {
        builder.accept_command(sexpr)?;
    }

    builder.finish()
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Sort {
    Bool,
    String,
    Symbolic(String),
}

impl Sort {
    fn canonical(&self) -> String {
        match self {
            Self::Bool => "Bool".to_string(),
            Self::String => "String".to_string(),
            Self::Symbolic(name) => canonical_symbol(name),
        }
    }

    fn is_scalar(&self) -> bool {
        !matches!(self, Self::Bool)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Definition {
    name: String,
    sort: Sort,
    body: DefinitionBody,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum DefinitionBody {
    Bool(BoolExpr),
    Scalar(ScalarExpr),
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum BoolExpr {
    Const(bool),
    Var(String),
    Defined(String),
    EqBool(Box<BoolExpr>, Box<BoolExpr>),
    EqScalar(ScalarExpr, ScalarExpr),
    And(Vec<BoolExpr>),
    Or(Vec<BoolExpr>),
    Not(Box<BoolExpr>),
    Implies(Box<BoolExpr>, Box<BoolExpr>),
    Ite(Box<BoolExpr>, Box<BoolExpr>, Box<BoolExpr>),
}

impl BoolExpr {
    fn canonical(&self) -> String {
        match self {
            Self::Const(true) => "true".to_string(),
            Self::Const(false) => "false".to_string(),
            Self::Var(name) | Self::Defined(name) => canonical_symbol(name),
            Self::EqBool(left, right) => {
                format!("(= {} {})", left.canonical(), right.canonical())
            }
            Self::EqScalar(left, right) => {
                format!("(= {} {})", left.canonical(), right.canonical())
            }
            Self::And(children) => canonical_list("and", children.iter().map(Self::canonical)),
            Self::Or(children) => canonical_list("or", children.iter().map(Self::canonical)),
            Self::Not(child) => format!("(not {})", child.canonical()),
            Self::Implies(left, right) => {
                format!("(=> {} {})", left.canonical(), right.canonical())
            }
            Self::Ite(condition, then_branch, else_branch) => format!(
                "(ite {} {} {})",
                condition.canonical(),
                then_branch.canonical(),
                else_branch.canonical()
            ),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ScalarExpr {
    Var(String),
    StringLiteral(String),
    SymbolLiteral(String),
    Defined(String),
    Ite(Box<BoolExpr>, Box<ScalarExpr>, Box<ScalarExpr>),
}

impl ScalarExpr {
    fn canonical(&self) -> String {
        match self {
            Self::Var(name) | Self::Defined(name) => canonical_symbol(name),
            Self::StringLiteral(value) => canonical_string(value),
            Self::SymbolLiteral(value) => canonical_symbol(value),
            Self::Ite(condition, then_branch, else_branch) => format!(
                "(ite {} {} {})",
                condition.canonical(),
                then_branch.canonical(),
                else_branch.canonical()
            ),
        }
    }
}

fn canonical_list(operator: &str, children: impl Iterator<Item = String>) -> String {
    let mut output = String::from("(");
    output.push_str(operator);
    for child in children {
        output.push(' ');
        output.push_str(&child);
    }
    output.push(')');
    output
}

fn canonical_symbol(value: &str) -> String {
    value.to_string()
}

fn canonical_string(value: &str) -> String {
    let mut output = String::from("\"");
    for character in value.chars() {
        if character == '"' {
            output.push('"');
            output.push('"');
        } else {
            output.push(character);
        }
    }
    output.push('"');
    output
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Token {
    LParen,
    RParen,
    Atom(String),
    StringLiteral(String),
}

struct Lexer<'a> {
    input: &'a str,
    cursor: usize,
}

impl<'a> Lexer<'a> {
    fn new(input: &'a str) -> Self {
        Self { input, cursor: 0 }
    }

    fn tokenize(mut self) -> Result<Vec<Token>, SmtPolicyError> {
        let mut tokens = Vec::new();

        while let Some(character) = self.peek_char() {
            match character {
                '(' => {
                    self.advance_char();
                    tokens.push(Token::LParen);
                }
                ')' => {
                    self.advance_char();
                    tokens.push(Token::RParen);
                }
                '"' => tokens.push(Token::StringLiteral(self.read_string()?)),
                ';' => self.skip_comment(),
                character if character.is_whitespace() => {
                    self.advance_char();
                }
                _ => tokens.push(Token::Atom(self.read_atom()?)),
            }
        }

        Ok(tokens)
    }

    fn peek_char(&self) -> Option<char> {
        self.input[self.cursor..].chars().next()
    }

    fn advance_char(&mut self) -> Option<char> {
        let character = self.peek_char()?;
        self.cursor += character.len_utf8();
        Some(character)
    }

    fn read_string(&mut self) -> Result<String, SmtPolicyError> {
        let opening = self.advance_char();
        debug_assert_eq!(opening, Some('"'));
        let mut output = String::new();

        loop {
            let Some(character) = self.advance_char() else {
                return Err(SmtPolicyError::Parse(
                    "unterminated string literal".to_string(),
                ));
            };

            if character == '"' {
                if self.peek_char() == Some('"') {
                    self.advance_char();
                    output.push('"');
                } else {
                    return Ok(output);
                }
            } else {
                output.push(character);
            }
        }
    }

    fn skip_comment(&mut self) {
        while let Some(character) = self.advance_char() {
            if character == '\n' {
                break;
            }
        }
    }

    fn read_atom(&mut self) -> Result<String, SmtPolicyError> {
        let mut output = String::new();

        while let Some(character) = self.peek_char() {
            if character.is_whitespace()
                || character == '('
                || character == ')'
                || character == '"'
                || character == ';'
            {
                break;
            }

            output.push(character);
            self.advance_char();
        }

        if output.is_empty() {
            Err(SmtPolicyError::Parse("expected token".to_string()))
        } else {
            Ok(output)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum SExpr {
    Atom(String),
    StringLiteral(String),
    List(Vec<SExpr>),
}

struct SExprParser {
    tokens: Vec<Token>,
    cursor: usize,
    max_nodes: usize,
    nodes: usize,
}

impl SExprParser {
    fn new(tokens: Vec<Token>, max_nodes: usize) -> Self {
        Self {
            tokens,
            cursor: 0,
            max_nodes,
            nodes: 0,
        }
    }

    fn parse_all(mut self) -> Result<Vec<SExpr>, SmtPolicyError> {
        let mut output = Vec::new();

        while self.cursor < self.tokens.len() {
            output.push(self.parse_one()?);
        }

        Ok(output)
    }

    fn parse_one(&mut self) -> Result<SExpr, SmtPolicyError> {
        self.bump_node()?;

        match self.next_token() {
            Some(Token::Atom(value)) => Ok(SExpr::Atom(value)),
            Some(Token::StringLiteral(value)) => Ok(SExpr::StringLiteral(value)),
            Some(Token::LParen) => {
                let mut children = Vec::new();
                while !matches!(self.peek_token(), Some(Token::RParen)) {
                    if self.peek_token().is_none() {
                        return Err(SmtPolicyError::Parse(
                            "missing closing parenthesis".to_string(),
                        ));
                    }
                    children.push(self.parse_one()?);
                }
                self.next_token();
                Ok(SExpr::List(children))
            }
            Some(Token::RParen) => Err(SmtPolicyError::Parse(
                "unexpected closing parenthesis".to_string(),
            )),
            None => Err(SmtPolicyError::Parse("unexpected end of input".to_string())),
        }
    }

    fn peek_token(&self) -> Option<&Token> {
        self.tokens.get(self.cursor)
    }

    fn next_token(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.cursor).cloned();
        if token.is_some() {
            self.cursor += 1;
        }
        token
    }

    fn bump_node(&mut self) -> Result<(), SmtPolicyError> {
        self.nodes += 1;
        if self.nodes > self.max_nodes {
            Err(SmtPolicyError::Limit(format!(
                "max_ast_nodes {}",
                self.max_nodes
            )))
        } else {
            Ok(())
        }
    }
}

struct PolicyBuilder {
    declarations: BTreeMap<String, Sort>,
    definitions: Vec<Definition>,
    definitions_by_name: BTreeMap<String, usize>,
    symbols: BTreeSet<String>,
    assertions: Vec<BoolExpr>,
    limits: SmtPolicyLimits,
    expr_nodes: usize,
    saw_check_sat: bool,
}

impl PolicyBuilder {
    fn new(limits: SmtPolicyLimits) -> Self {
        Self {
            declarations: BTreeMap::new(),
            definitions: Vec::new(),
            definitions_by_name: BTreeMap::new(),
            symbols: BTreeSet::new(),
            assertions: Vec::new(),
            limits,
            expr_nodes: 0,
            saw_check_sat: false,
        }
    }

    fn accept_command(&mut self, sexpr: &SExpr) -> Result<(), SmtPolicyError> {
        let list = expect_list(sexpr, "top-level command")?;
        let command = expect_atom(list.first(), "command")?;

        match command {
            "declare-const" => self.accept_declare_const(list),
            "define-fun" => self.accept_define_fun(list),
            "assert" => self.accept_assert(list),
            "check-sat" => {
                if list.len() != 1 {
                    return Err(SmtPolicyError::Invalid(
                        "check-sat must not have arguments".to_string(),
                    ));
                }
                self.saw_check_sat = true;
                Ok(())
            }
            "declare-fun" => Err(SmtPolicyError::Unsupported(
                "declare-fun would introduce arbitrary function application".to_string(),
            )),
            "get-model" | "get-value" | "get-proof" | "get-unsat-core" => {
                Err(SmtPolicyError::Unsupported(
                    "model generation commands are not allowed".to_string(),
                ))
            }
            other => Err(SmtPolicyError::Unsupported(format!(
                "command {other} is not in the v1 fragment"
            ))),
        }
    }

    fn accept_declare_const(&mut self, list: &[SExpr]) -> Result<(), SmtPolicyError> {
        if list.len() != 3 {
            return Err(SmtPolicyError::Invalid(
                "declare-const requires name and sort".to_string(),
            ));
        }

        let name = expect_atom(list.get(1), "declare-const name")?;
        validate_identifier(name)?;
        self.ensure_unique_symbol(name)?;
        let sort = parse_sort(list.get(2))?;
        self.declarations.insert(name.to_string(), sort);
        Ok(())
    }

    fn accept_define_fun(&mut self, list: &[SExpr]) -> Result<(), SmtPolicyError> {
        if list.len() != 5 {
            return Err(SmtPolicyError::Invalid(
                "define-fun requires name, empty parameters, return sort, and body".to_string(),
            ));
        }

        let name = expect_atom(list.get(1), "define-fun name")?;
        validate_identifier(name)?;
        self.ensure_unique_symbol(name)?;
        let params = expect_list(
            list.get(2).ok_or_else(|| {
                SmtPolicyError::Invalid("define-fun parameters are missing".to_string())
            })?,
            "define-fun parameters",
        )?;
        if !params.is_empty() {
            return Err(SmtPolicyError::Unsupported(
                "define-fun parameters are not allowed".to_string(),
            ));
        }

        let sort = parse_sort(list.get(3))?;
        let body = if sort == Sort::Bool {
            DefinitionBody::Bool(self.parse_bool_expr(
                list.get(4).ok_or_else(|| {
                    SmtPolicyError::Invalid("define-fun body is missing".to_string())
                })?,
                Some(name),
            )?)
        } else {
            DefinitionBody::Scalar(self.parse_scalar_expr(
                list.get(4).ok_or_else(|| {
                    SmtPolicyError::Invalid("define-fun body is missing".to_string())
                })?,
                Some(name),
            )?)
        };

        let index = self.definitions.len();
        self.definitions.push(Definition {
            name: name.to_string(),
            sort,
            body,
        });
        self.definitions_by_name.insert(name.to_string(), index);
        Ok(())
    }

    fn accept_assert(&mut self, list: &[SExpr]) -> Result<(), SmtPolicyError> {
        if list.len() != 2 {
            return Err(SmtPolicyError::Invalid(
                "assert requires exactly one expression".to_string(),
            ));
        }
        if self.assertions.len() >= self.limits.max_assertions {
            return Err(SmtPolicyError::Limit(format!(
                "max_assertions {}",
                self.limits.max_assertions
            )));
        }

        let assertion = self.parse_bool_expr(
            list.get(1)
                .ok_or_else(|| SmtPolicyError::Invalid("assertion missing".to_string()))?,
            None,
        )?;
        self.assertions.push(assertion);
        Ok(())
    }

    fn finish(self) -> Result<SmtPolicy, SmtPolicyError> {
        let mut policy = SmtPolicy {
            declarations: self.declarations,
            definitions: self.definitions,
            definitions_by_name: self.definitions_by_name,
            assertions: self.assertions,
            normalized_hash: [0; SMT_POLICY_HASH_BYTES],
            max_evaluator_fuel: self.limits.max_evaluator_fuel,
        };
        let digest = Sha256::digest(policy.canonical_bytes());
        policy.normalized_hash.copy_from_slice(&digest);
        Ok(policy)
    }

    fn parse_bool_expr(
        &mut self,
        sexpr: &SExpr,
        defining: Option<&str>,
    ) -> Result<BoolExpr, SmtPolicyError> {
        self.bump_expr_node()?;

        match sexpr {
            SExpr::Atom(value) if value == "true" => Ok(BoolExpr::Const(true)),
            SExpr::Atom(value) if value == "false" => Ok(BoolExpr::Const(false)),
            SExpr::Atom(value) => {
                if Some(value.as_str()) == defining {
                    return Err(SmtPolicyError::Invalid(
                        "recursive define-fun is not allowed".to_string(),
                    ));
                }
                if self.declarations.get(value) == Some(&Sort::Bool) {
                    Ok(BoolExpr::Var(value.to_string()))
                } else if self.definition_sort(value) == Some(Sort::Bool) {
                    Ok(BoolExpr::Defined(value.to_string()))
                } else if self.declarations.contains_key(value)
                    || self.definitions_by_name.contains_key(value)
                {
                    Err(SmtPolicyError::Invalid(format!("{value} is not Bool")))
                } else {
                    Err(SmtPolicyError::Invalid(format!(
                        "unknown Bool symbol {value}"
                    )))
                }
            }
            SExpr::StringLiteral(_) => Err(SmtPolicyError::Invalid(
                "string literal cannot be used as Bool".to_string(),
            )),
            SExpr::List(items) => self.parse_bool_list(items, defining),
        }
    }

    fn parse_bool_list(
        &mut self,
        items: &[SExpr],
        defining: Option<&str>,
    ) -> Result<BoolExpr, SmtPolicyError> {
        let operator = expect_atom(items.first(), "Bool expression operator")?;

        match operator {
            "and" => {
                if items.len() < 2 {
                    return Err(SmtPolicyError::Invalid(
                        "and requires at least one operand".to_string(),
                    ));
                }
                let mut children = Vec::new();
                for child in &items[1..] {
                    children.push(self.parse_bool_expr(child, defining)?);
                }
                Ok(BoolExpr::And(children))
            }
            "or" => {
                if items.len() < 2 {
                    return Err(SmtPolicyError::Invalid(
                        "or requires at least one operand".to_string(),
                    ));
                }
                let mut children = Vec::new();
                for child in &items[1..] {
                    children.push(self.parse_bool_expr(child, defining)?);
                }
                Ok(BoolExpr::Or(children))
            }
            "not" => {
                if items.len() != 2 {
                    return Err(SmtPolicyError::Invalid(
                        "not requires exactly one operand".to_string(),
                    ));
                }
                Ok(BoolExpr::Not(Box::new(
                    self.parse_bool_expr(&items[1], defining)?,
                )))
            }
            "=>" => {
                if items.len() != 3 {
                    return Err(SmtPolicyError::Invalid(
                        "=> requires exactly two operands".to_string(),
                    ));
                }
                Ok(BoolExpr::Implies(
                    Box::new(self.parse_bool_expr(&items[1], defining)?),
                    Box::new(self.parse_bool_expr(&items[2], defining)?),
                ))
            }
            "=" => self.parse_equality(items, defining),
            "ite" => {
                if items.len() != 4 {
                    return Err(SmtPolicyError::Invalid(
                        "ite requires condition, then branch, and else branch".to_string(),
                    ));
                }
                Ok(BoolExpr::Ite(
                    Box::new(self.parse_bool_expr(&items[1], defining)?),
                    Box::new(self.parse_bool_expr(&items[2], defining)?),
                    Box::new(self.parse_bool_expr(&items[3], defining)?),
                ))
            }
            name if items.len() == 1 && self.definition_sort(name) == Some(Sort::Bool) => {
                if Some(name) == defining {
                    return Err(SmtPolicyError::Invalid(
                        "recursive define-fun is not allowed".to_string(),
                    ));
                }
                Ok(BoolExpr::Defined(name.to_string()))
            }
            "forall" | "exists" => Err(SmtPolicyError::Unsupported(
                "quantifiers are not allowed".to_string(),
            )),
            "select" | "store" | "Array" => Err(SmtPolicyError::Unsupported(
                "arrays are not allowed".to_string(),
            )),
            "+" | "-" | "*" | "div" | "mod" | "<" | "<=" | ">" | ">=" => Err(
                SmtPolicyError::Unsupported("arithmetic is not allowed".to_string()),
            ),
            "str.contains" | "str.prefixof" | "str.suffixof" | "str.len" | "str.in_re" | "re.*"
            | "re.+" | "re.union" | "re.inter" => Err(SmtPolicyError::Unsupported(
                "string solver and regex operators are not allowed".to_string(),
            )),
            "distinct" | "/=" => Err(SmtPolicyError::Unsupported(
                "disequality is not in the v1 fragment".to_string(),
            )),
            other => Err(SmtPolicyError::Unsupported(format!(
                "function application {other} is not allowed"
            ))),
        }
    }

    fn parse_equality(
        &mut self,
        items: &[SExpr],
        defining: Option<&str>,
    ) -> Result<BoolExpr, SmtPolicyError> {
        if items.len() != 3 {
            return Err(SmtPolicyError::Invalid(
                "= requires exactly two operands".to_string(),
            ));
        }

        if self.sexpr_starts_bool(&items[1]) || self.sexpr_starts_bool(&items[2]) {
            Ok(BoolExpr::EqBool(
                Box::new(self.parse_bool_expr(&items[1], defining)?),
                Box::new(self.parse_bool_expr(&items[2], defining)?),
            ))
        } else {
            Ok(BoolExpr::EqScalar(
                self.parse_scalar_expr(&items[1], defining)?,
                self.parse_scalar_expr(&items[2], defining)?,
            ))
        }
    }

    fn parse_scalar_expr(
        &mut self,
        sexpr: &SExpr,
        defining: Option<&str>,
    ) -> Result<ScalarExpr, SmtPolicyError> {
        self.bump_expr_node()?;

        match sexpr {
            SExpr::StringLiteral(value) => Ok(ScalarExpr::StringLiteral(value.clone())),
            SExpr::Atom(value) => {
                if value == "true" || value == "false" {
                    return Err(SmtPolicyError::Invalid(
                        "Bool literal cannot be used as scalar".to_string(),
                    ));
                }
                if Some(value.as_str()) == defining {
                    return Err(SmtPolicyError::Invalid(
                        "recursive define-fun is not allowed".to_string(),
                    ));
                }
                if matches!(self.declarations.get(value), Some(sort) if sort.is_scalar()) {
                    Ok(ScalarExpr::Var(value.to_string()))
                } else if matches!(self.definition_sort(value), Some(sort) if sort.is_scalar()) {
                    Ok(ScalarExpr::Defined(value.to_string()))
                } else if self.declarations.get(value) == Some(&Sort::Bool)
                    || self.definition_sort(value) == Some(Sort::Bool)
                {
                    Err(SmtPolicyError::Invalid(format!("{value} is not scalar")))
                } else {
                    validate_symbol_literal(value)?;
                    Ok(ScalarExpr::SymbolLiteral(value.to_string()))
                }
            }
            SExpr::List(items) => {
                let operator = expect_atom(items.first(), "scalar expression operator")?;
                match operator {
                    "ite" => {
                        if items.len() != 4 {
                            return Err(SmtPolicyError::Invalid(
                                "ite requires condition, then branch, and else branch".to_string(),
                            ));
                        }
                        Ok(ScalarExpr::Ite(
                            Box::new(self.parse_bool_expr(&items[1], defining)?),
                            Box::new(self.parse_scalar_expr(&items[2], defining)?),
                            Box::new(self.parse_scalar_expr(&items[3], defining)?),
                        ))
                    }
                    name if items.len() == 1
                        && matches!(self.definition_sort(name), Some(sort) if sort.is_scalar()) =>
                    {
                        if Some(name) == defining {
                            return Err(SmtPolicyError::Invalid(
                                "recursive define-fun is not allowed".to_string(),
                            ));
                        }
                        Ok(ScalarExpr::Defined(name.to_string()))
                    }
                    "forall" | "exists" => Err(SmtPolicyError::Unsupported(
                        "quantifiers are not allowed".to_string(),
                    )),
                    "select" | "store" | "Array" => Err(SmtPolicyError::Unsupported(
                        "arrays are not allowed".to_string(),
                    )),
                    "+" | "-" | "*" | "div" | "mod" | "<" | "<=" | ">" | ">=" => Err(
                        SmtPolicyError::Unsupported("arithmetic is not allowed".to_string()),
                    ),
                    "str.contains" | "str.prefixof" | "str.suffixof" | "str.len" | "str.in_re"
                    | "re.*" | "re.+" | "re.union" | "re.inter" => {
                        Err(SmtPolicyError::Unsupported(
                            "string solver and regex operators are not allowed".to_string(),
                        ))
                    }
                    other => Err(SmtPolicyError::Unsupported(format!(
                        "function application {other} is not allowed"
                    ))),
                }
            }
        }
    }

    fn sexpr_starts_bool(&self, sexpr: &SExpr) -> bool {
        match sexpr {
            SExpr::Atom(value) => {
                value == "true"
                    || value == "false"
                    || self.declarations.get(value) == Some(&Sort::Bool)
                    || self.definition_sort(value) == Some(Sort::Bool)
            }
            SExpr::List(items) => {
                let Some(SExpr::Atom(operator)) = items.first() else {
                    return false;
                };
                matches!(operator.as_str(), "and" | "or" | "not" | "=>" | "=" | "ite")
                    || self.definition_sort(operator) == Some(Sort::Bool)
            }
            SExpr::StringLiteral(_) => false,
        }
    }

    fn definition_sort(&self, name: &str) -> Option<Sort> {
        let index = self.definitions_by_name.get(name)?;
        Some(self.definitions.get(*index)?.sort.clone())
    }

    fn ensure_unique_symbol(&mut self, name: &str) -> Result<(), SmtPolicyError> {
        if self.symbols.contains(name) {
            return Err(SmtPolicyError::Invalid(format!("duplicate symbol {name}")));
        }

        self.symbols.insert(name.to_string());
        if self.symbols.len() > self.limits.max_symbols {
            Err(SmtPolicyError::Limit(format!(
                "max_symbols {}",
                self.limits.max_symbols
            )))
        } else {
            Ok(())
        }
    }

    fn bump_expr_node(&mut self) -> Result<(), SmtPolicyError> {
        self.expr_nodes += 1;
        if self.expr_nodes > self.limits.max_ast_nodes {
            Err(SmtPolicyError::Limit(format!(
                "max_ast_nodes {}",
                self.limits.max_ast_nodes
            )))
        } else {
            Ok(())
        }
    }
}

fn expect_list<'a>(sexpr: &'a SExpr, context: &str) -> Result<&'a [SExpr], SmtPolicyError> {
    match sexpr {
        SExpr::List(items) => Ok(items),
        _ => Err(SmtPolicyError::Parse(format!("{context} must be a list"))),
    }
}

fn expect_atom<'a>(sexpr: Option<&'a SExpr>, context: &str) -> Result<&'a str, SmtPolicyError> {
    match sexpr {
        Some(SExpr::Atom(value)) => Ok(value),
        Some(SExpr::StringLiteral(_)) => Err(SmtPolicyError::Parse(format!(
            "{context} must be a symbol, not a string"
        ))),
        Some(SExpr::List(_)) => Err(SmtPolicyError::Parse(format!("{context} must be a symbol"))),
        None => Err(SmtPolicyError::Parse(format!("{context} is missing"))),
    }
}

fn parse_sort(sexpr: Option<&SExpr>) -> Result<Sort, SmtPolicyError> {
    let name = expect_atom(sexpr, "sort")?;
    match name {
        "Bool" => Ok(Sort::Bool),
        "String" => Ok(Sort::String),
        "Array" => Err(SmtPolicyError::Unsupported(
            "arrays are not allowed".to_string(),
        )),
        other => {
            validate_identifier(other)?;
            Ok(Sort::Symbolic(other.to_string()))
        }
    }
}

fn validate_identifier(value: &str) -> Result<(), SmtPolicyError> {
    if is_plain_identifier(value) && !is_reserved_word(value) {
        Ok(())
    } else {
        Err(SmtPolicyError::Invalid(format!(
            "invalid identifier {value}"
        )))
    }
}

fn validate_symbol_literal(value: &str) -> Result<(), SmtPolicyError> {
    if is_plain_identifier(value)
        && !value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_digit())
    {
        Ok(())
    } else {
        Err(SmtPolicyError::Invalid(format!(
            "invalid symbolic literal {value}"
        )))
    }
}

fn is_plain_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if first == '|' || first.is_ascii_digit() {
        return false;
    }
    value.chars().all(|character| {
        character.is_ascii_alphanumeric()
            || matches!(
                character,
                '_' | '-' | '.' | '/' | ':' | '?' | '!' | '$' | '%' | '&' | '~' | '^' | '@'
            )
    })
}

fn is_reserved_word(value: &str) -> bool {
    matches!(
        value,
        "true"
            | "false"
            | "Bool"
            | "String"
            | "and"
            | "or"
            | "not"
            | "=>"
            | "="
            | "ite"
            | "assert"
            | "declare-const"
            | "declare-fun"
            | "define-fun"
            | "check-sat"
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum EvalOutcome<T> {
    Known(T),
    Unknown,
    FuelExhausted,
}

struct Evaluator<'a> {
    policy: &'a SmtPolicy,
    facts: &'a ActionFacts,
    fuel: usize,
}

impl Evaluator<'_> {
    fn eval_bool(&mut self, expr: &BoolExpr) -> EvalOutcome<bool> {
        if !self.consume_fuel() {
            return EvalOutcome::FuelExhausted;
        }

        match expr {
            BoolExpr::Const(value) => EvalOutcome::Known(*value),
            BoolExpr::Var(name) => match self.facts.values.get(name) {
                Some(FactValue::Bool(value)) => EvalOutcome::Known(*value),
                _ => EvalOutcome::Unknown,
            },
            BoolExpr::Defined(name) => self.eval_defined_bool(name),
            BoolExpr::EqBool(left, right) => match (self.eval_bool(left), self.eval_bool(right)) {
                (EvalOutcome::Known(left), EvalOutcome::Known(right)) => {
                    EvalOutcome::Known(left == right)
                }
                (EvalOutcome::FuelExhausted, _) | (_, EvalOutcome::FuelExhausted) => {
                    EvalOutcome::FuelExhausted
                }
                _ => EvalOutcome::Unknown,
            },
            BoolExpr::EqScalar(left, right) => {
                match (self.eval_scalar(left), self.eval_scalar(right)) {
                    (EvalOutcome::Known(left), EvalOutcome::Known(right)) => {
                        EvalOutcome::Known(left == right)
                    }
                    (EvalOutcome::FuelExhausted, _) | (_, EvalOutcome::FuelExhausted) => {
                        EvalOutcome::FuelExhausted
                    }
                    _ => EvalOutcome::Unknown,
                }
            }
            BoolExpr::And(children) => {
                let mut saw_unknown = false;
                for child in children {
                    match self.eval_bool(child) {
                        EvalOutcome::Known(true) => {}
                        EvalOutcome::Known(false) => return EvalOutcome::Known(false),
                        EvalOutcome::Unknown => saw_unknown = true,
                        EvalOutcome::FuelExhausted => return EvalOutcome::FuelExhausted,
                    }
                }
                if saw_unknown {
                    EvalOutcome::Unknown
                } else {
                    EvalOutcome::Known(true)
                }
            }
            BoolExpr::Or(children) => {
                let mut saw_unknown = false;
                for child in children {
                    match self.eval_bool(child) {
                        EvalOutcome::Known(true) => return EvalOutcome::Known(true),
                        EvalOutcome::Known(false) => {}
                        EvalOutcome::Unknown => saw_unknown = true,
                        EvalOutcome::FuelExhausted => return EvalOutcome::FuelExhausted,
                    }
                }
                if saw_unknown {
                    EvalOutcome::Unknown
                } else {
                    EvalOutcome::Known(false)
                }
            }
            BoolExpr::Not(child) => match self.eval_bool(child) {
                EvalOutcome::Known(value) => EvalOutcome::Known(!value),
                EvalOutcome::Unknown => EvalOutcome::Unknown,
                EvalOutcome::FuelExhausted => EvalOutcome::FuelExhausted,
            },
            BoolExpr::Implies(left, right) => match self.eval_bool(left) {
                EvalOutcome::Known(false) => EvalOutcome::Known(true),
                EvalOutcome::Known(true) => self.eval_bool(right),
                EvalOutcome::Unknown => match self.eval_bool(right) {
                    EvalOutcome::Known(true) => EvalOutcome::Known(true),
                    EvalOutcome::Known(false) | EvalOutcome::Unknown => EvalOutcome::Unknown,
                    EvalOutcome::FuelExhausted => EvalOutcome::FuelExhausted,
                },
                EvalOutcome::FuelExhausted => EvalOutcome::FuelExhausted,
            },
            BoolExpr::Ite(condition, then_branch, else_branch) => match self.eval_bool(condition) {
                EvalOutcome::Known(true) => self.eval_bool(then_branch),
                EvalOutcome::Known(false) => self.eval_bool(else_branch),
                EvalOutcome::Unknown => EvalOutcome::Unknown,
                EvalOutcome::FuelExhausted => EvalOutcome::FuelExhausted,
            },
        }
    }

    fn eval_scalar(&mut self, expr: &ScalarExpr) -> EvalOutcome<String> {
        if !self.consume_fuel() {
            return EvalOutcome::FuelExhausted;
        }

        match expr {
            ScalarExpr::Var(name) => match self.facts.values.get(name) {
                Some(FactValue::Scalar(value)) => EvalOutcome::Known(value.clone()),
                _ => EvalOutcome::Unknown,
            },
            ScalarExpr::StringLiteral(value) | ScalarExpr::SymbolLiteral(value) => {
                EvalOutcome::Known(value.clone())
            }
            ScalarExpr::Defined(name) => self.eval_defined_scalar(name),
            ScalarExpr::Ite(condition, then_branch, else_branch) => {
                match self.eval_bool(condition) {
                    EvalOutcome::Known(true) => self.eval_scalar(then_branch),
                    EvalOutcome::Known(false) => self.eval_scalar(else_branch),
                    EvalOutcome::Unknown => EvalOutcome::Unknown,
                    EvalOutcome::FuelExhausted => EvalOutcome::FuelExhausted,
                }
            }
        }
    }

    fn eval_defined_bool(&mut self, name: &str) -> EvalOutcome<bool> {
        let Some(body) = self.lookup_definition_body(name) else {
            return EvalOutcome::Unknown;
        };
        match body {
            DefinitionBody::Bool(body) => self.eval_bool(&body),
            DefinitionBody::Scalar(_) => EvalOutcome::Unknown,
        }
    }

    fn eval_defined_scalar(&mut self, name: &str) -> EvalOutcome<String> {
        let Some(body) = self.lookup_definition_body(name) else {
            return EvalOutcome::Unknown;
        };
        match body {
            DefinitionBody::Bool(_) => EvalOutcome::Unknown,
            DefinitionBody::Scalar(body) => self.eval_scalar(&body),
        }
    }

    fn lookup_definition_body(&self, name: &str) -> Option<DefinitionBody> {
        let index = self.policy.definitions_by_name.get(name)?;
        Some(self.policy.definitions.get(*index)?.body.clone())
    }

    fn consume_fuel(&mut self) -> bool {
        let Some(next) = self.fuel.checked_sub(1) else {
            return false;
        };
        self.fuel = next;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_ok(text: &str) -> SmtPolicy {
        parse_smt_policy(text).expect("policy should parse")
    }

    fn parse_err(text: &str) -> String {
        parse_smt_policy(text)
            .expect_err("policy should fail")
            .to_string()
    }

    #[test]
    fn accepts_supported_fragment_and_hash_is_whitespace_stable() {
        let compact = r#"
            (declare-const action String)
            (declare-const role Role)
            (define-fun is_owner () Bool (= role owner))
            (assert (=> (= action "read") (or (is_owner) (= role "reader"))))
            (check-sat)
        "#;
        let spaced = r#"
            ; comment should not affect the normalized AST
            ( declare-const action String )
            (declare-const role Role)
            (define-fun is_owner () Bool
                (= role owner))
            (assert
                (=> (= action "read")
                    (or is_owner (= role "reader"))))
            (check-sat)
        "#;

        let first = parse_ok(compact);
        let second = parse_ok(spaced);

        assert_eq!(first.assertion_count(), 1);
        assert_eq!(first.normalized_hash(), second.normalized_hash());
        assert_eq!(first.normalized_hash_hex().len(), SMT_POLICY_HASH_BYTES * 2);
    }

    #[test]
    fn evaluates_allow_deny_and_blocked() {
        let policy = parse_ok(
            r#"
            (declare-const action String)
            (declare-const role String)
            (declare-const archived Bool)
            (assert (and (= action "read") (not archived) (= role "reader")))
            "#,
        );
        let mut allow = ActionFacts::new();
        allow.insert_scalar("action", "read");
        allow.insert_scalar("role", "reader");
        allow.insert_bool("archived", false);

        let mut deny = allow.clone();
        deny.insert_bool("archived", true);

        let mut blocked = ActionFacts::new();
        blocked.insert_scalar("action", "read");

        assert_eq!(policy.evaluate(&allow), PolicyDecision::Allow);
        assert_eq!(policy.evaluate(&deny), PolicyDecision::Deny);
        assert_eq!(policy.evaluate(&blocked), PolicyDecision::Blocked);
    }

    #[test]
    fn evaluates_ite_and_boolean_equality() {
        let policy = parse_ok(
            r#"
            (declare-const action String)
            (declare-const member Bool)
            (define-fun expected () String (ite member "private" "public"))
            (assert (= (= action expected) true))
            "#,
        );
        let mut facts = ActionFacts::new();
        facts.insert_scalar("action", "private");
        facts.insert_bool("member", true);

        assert_eq!(policy.evaluate(&facts), PolicyDecision::Allow);
    }

    #[test]
    fn rejects_quantifiers_arrays_arithmetic_regex_and_model_generation() {
        assert!(parse_err("(assert (forall ((x String)) (= x \"a\")))").contains("quantifiers"));
        assert!(parse_err("(declare-const xs Array)").contains("arrays"));
        assert!(parse_err("(assert (> age 1))").contains("arithmetic"));
        assert!(parse_err("(assert (str.contains path \"secret\"))").contains("string solver"));
        assert!(parse_err("(get-model)").contains("model generation"));
    }

    #[test]
    fn rejects_recursion_parameters_and_arbitrary_function_application() {
        assert!(parse_err("(define-fun f ((x String)) Bool true)").contains("parameters"));
        assert!(parse_err("(define-fun f () Bool f)").contains("recursive"));
        assert!(parse_err("(assert (custom action))").contains("function application"));
    }

    #[test]
    fn enforces_upload_limits() {
        let limits = SmtPolicyLimits {
            max_bytes: 8,
            ..SmtPolicyLimits::default()
        };
        assert!(
            parse_smt_policy_with_limits("(check-sat)", limits)
                .expect_err("byte limit should fail")
                .to_string()
                .contains("max_bytes")
        );

        let limits = SmtPolicyLimits {
            max_ast_nodes: 2,
            ..SmtPolicyLimits::default()
        };
        assert!(
            parse_smt_policy_with_limits("(assert true)", limits)
                .expect_err("node limit should fail")
                .to_string()
                .contains("max_ast_nodes")
        );

        let limits = SmtPolicyLimits {
            max_assertions: 1,
            ..SmtPolicyLimits::default()
        };
        assert!(
            parse_smt_policy_with_limits("(assert true) (assert true)", limits)
                .expect_err("assertion limit should fail")
                .to_string()
                .contains("max_assertions")
        );

        let limits = SmtPolicyLimits {
            max_symbols: 1,
            ..SmtPolicyLimits::default()
        };
        assert!(
            parse_smt_policy_with_limits(
                "(declare-const action String) (declare-const role String)",
                limits
            )
            .expect_err("symbol limit should fail")
            .to_string()
            .contains("max_symbols")
        );
    }

    #[test]
    fn evaluator_fuel_exhaustion_blocks() {
        let limits = SmtPolicyLimits {
            max_evaluator_fuel: 1,
            ..SmtPolicyLimits::default()
        };
        let policy = parse_smt_policy_with_limits(
            r#"
            (declare-const action String)
            (assert (= action "read"))
            "#,
            limits,
        )
        .expect("policy should parse");
        let mut facts = ActionFacts::new();
        facts.insert_scalar("action", "read");

        assert_eq!(policy.evaluate(&facts), PolicyDecision::Blocked);
    }

    #[test]
    fn malformed_strings_and_unknown_bool_symbols_fail_closed() {
        assert!(parse_err("(assert \"x\")").contains("string literal cannot be used as Bool"));
        assert!(parse_err("(assert allowed)").contains("unknown Bool symbol"));
        assert!(parse_err("(assert (= action 1))").contains("invalid symbolic literal"));
    }
}
