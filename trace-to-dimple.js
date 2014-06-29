/* global require, module */

/*

 Take a finite trace which is in simple form (eg output of trace.js) and convert into a set of Dimple calls to construct a factor graph.
 Call a dimple solver. (What's the right church abstraction? 'dimple-query'? needs access to traced source, not just thunk though.)
 
 Input langauge (in SSA except that the final var in an 'if' is assigned in each branch):
 assignment: var = function(var, ...)
 conditional: if(var){...; assignment} else {...; assignment}
 evidence: condition(var) | factor(var)
 
 Translation to dimple is pretty straightforward, except that a bunch of information is needed about primitive functions:
    dimpleReturnType maps from a function to the return type, 
    dimpleFactor maps from a function to the corresponding dimple factor function.

 
 overall the translation is something like (using <> as unquote):
 
 header:
    FactorGraph myGraph = new FactorGraph();
 
 dimpleVarDec(“var ab1 = foo(ab2, ab3)”)
    —>
        <dimpleReturnType(“foo”)> ab1 = new <dimpleReturnType(“foo”)>();
        myGraph.addFactor(<dimpleFactor(“foo”)>, ab1, ab2, ab3);
 dimpleEvidence("condition(ab1)")
    ->
        ab1.FixedValue = true;
 dimpleEvidence("factor(ab1)")
    ->
        myGraph.addFactor(<some-dimple-factor-that-just-returns-the-input-value, ab1)>
 
 
 
 
 dimpleReturnType is basically a table mapping functions to dimple types. according to the dimple manual, dimple supports the following types for variables:
    Discrete (i.e. enumerated), 
    Bit (i.e. enum [0,1]), 
    Real, 
    RealJoint (more or less a vector of Reals?),
    FiniteFieldVariable
 
 dimpleFactor has mappings like:
    flip —> Bernoulli
    and -> And
 notes:
    -most dimple built-in factors have church/js equivalents.
    -if we handle church_buitlins and erps we'll get most cases.
    -sometimes the arg patterns mismatch. need to wrap them up.
    -for ERPs without dimple builtins we could wrap up scoring code (or ask dimple team to add them…).
    -are there (common) church/js deterministic functions that don’t have dimple builtins? can we translate to java directly? (is it possible to automatically generate java functions for deterministic parts using Rhino or another js->java compiler?)
 
 treatment for condition and factor statements:
    -factor statements can get directly translated into dimple factor statements. (note we may eventually want to intercept the expression computing score before it gets traced, because otherwise we generate a ton of variables with deterministic dependencies. i don't know how well dimple deals with these.)
    -condition statements translate fixed values of variables: condition(var) --> var.FixedValue = T;
    -directly conditioned erps get that as the var.FixedValue.

 inference and execution:
    how flexible should the dimple solver call be? maybe start by just choosing one, later can pass control args that setup the solver.
    initially we can just generate a source code file which we run with java by system call?
    what's the simplest js<->java glue to use more generally? maybe wrap dimple as an applet and call methods using browser magic?

 
 TODO:
 
 -Update the above spec, given that i've changed the function signatures somewhat... ;)
 -First pass assumes all variables are boolean, only erp is flip, and primitives are: and, or, not. 
   -Need to do correct dimple translations.
   -Make basic models to test the pipeline.
   - handle querying
 - handle constructor arguments for Dimple variable types like Discrete and Real
 - handle If statements

*/


var escodegen = require('escodegen');
var esprima = require('esprima');
var _ = require('underscore');

_.templateSettings = {
  interpolate: /\{\{(.+?)\}\}/g
};

//var dimpleCode = ""
function toDimpleFile(line) {
//    console.log(line)
//    dimpleCode = dimpleCode + line +"\n"
}

var log = function() {
    var args = Array.prototype.slice.call(arguments);
    console.log(args.join("\n"));
}

// works on either ast or strings
function traceToDimple(x) {
    var ast = (typeof x == 'string') ? ast = esprima.parse(x) : x
    var dimpleCode = "";

    function add(code) {
        dimpleCode += "\n" + code;
    }
    
    // TODO: we might have to create subgraphs
    // i need to figure out how to name and keep track of these

    if (ast.type == 'Identifier') {
        return ast.name;
    } else if (ast.type == 'ExpressionStatement') { 
        //should be final statement which is return value.
        //todo: make a dimple-query in webchurch that runs a solver and returns the marginal on this final statement??

        add( "myGraph.getSolver().setNumIterations(10000);" );
        add( "myGraph.solve();\n");

        // TODO: figure out how to handle variables with infinite support 
		    add( "double [] belief = " + ast.expression.name + ".getBelief();" );
		    add( "System.out.println(Arrays.toString(belief));"); 
    } else if (ast.type == 'VariableDeclaration') {
        // a VariableDeclaration is a node of the form
        // var {id} = {init}
        // where {id} will parse to an Identifier object
        // and {init} will parse to an Expression object (I think this code currently assumes
        // that it will be a CallExpression, in particular. this is to be contrasted with
        // a BinaryExpression (e.g., 1 + x) or an ObjectExpression (e.g., x) 
        
        //assume one declarator per declaration.
        var decl = ast.declarations[0]
        var id = decl.id.name
        var init = decl.init

        if (init.type == "CallExpression") {
            var callee = init.callee.name
            if(callee == 'condition' || callee == 'factor') {
                add( dimpleEvidence(init) );
            } else {
                add( dimpleVarDec(id, init) );
            }
        } else if (init.type == 'Literal') {
            // TODO: fix this to 
            add( + escodegen.generate(ast) );
            
        }
    } else if (ast.type == 'IfStatement') {

        // TODO: singleton object pattern for decreasing memory usage
        // if we've got a ton of if statements

        var dat = {
            // create a variable for the selector string
            selector: traceToDimple(ast.test),
            consequent: traceToDimple(ast.consequent),
            alternate: traceToDimple(ast.alternate)
        };

        var t = "myGraph.addFactor(new Multiplexer(), [out1], {{selector}}, {{consequent}}, {{alternate}})";

        add(_.template(t, dat)); 
    } else if (ast.type == 'Program') {
        // walk through the ast
        var lines = ast.body
                .map(function(subast) {
                    return traceToDimple(subast)
                });
        add(lines.join("\n")); 
    } else {
        throw new Error("Haven't implemented translation for expression of type " + ast.type)
    }
    
    return dimpleCode
}

//evidence comes from condition and factor statements in the church code
//assume the expression is an identifier for both cases.

// conditioning on a boolean requires that we do
// .setFixedValue(1)
// since we apparently don't have true Booleans in dimple
function dimpleEvidence(init) {
    var evexp = init.arguments[0].name
    if(init.callee.name == 'condition'){
        // toDimpleFile( evexp+ ".setFixedValue(1);");
        return evexp+ ".setFixedValue(1);";
        
    } else if (init.callee.name == 'factor') {
        //todo: myGraph.addFactor(<some-dimple-factor-that-just-returns-the-input-value, ab1)>
    }
}

//most trace statements will be declarations of the form 'var ab0 = foo(ab1,const);'
// id is the ab0 part
// init is the foo(ab1, const) part
function dimpleVarDec(id, init) {
    var callee = init.callee.name
    //get args, which might each be literal, identifier, or array:
    var args = []
    for(var i = 0, ii = init.arguments.length; i < ii; i++) {
        var arg = init.arguments[i]
        switch(arg.type) {
        case 'Literal':
            args.push(arg.value)
            break
            
        case 'Identifier':
            args.push(arg.name)
            break
            
        case 'ArrayExpression':
            // unparse each esprima object into a javascript string
            var arr = arg.elements.map(function(el) {
                return escodegen.generate(el)
            }) 
            args.push(arr)
            break
        }
    }

    // this is required because the tracer turns ERP calls like (flip 0.5)
    // into javascript like:
    // var ab0 = random('wrapped_flip',[0.5,JSON.parse('null')]);
    // so the function call we'll be dealing with for ERPs is actually
    // a call to random, rather than wrapped_flip. here, we just unwrap
    // the random() call
    if(callee=='random') {
        callee = args[0]
        args = args[1]
    }
    
    //Generate Dimple statements
    var factor = new DimpleFactor(id, callee, args)

    return factor.java;
    // toDimpleFile( "myGraph.addFactor(new {{factor}}(), {{id}}, {{factorArgString}""
    
}


// you call this by using the "new" keyword
// e.g.,
// var factor = new DimpleFactor("ab2", "or", ["ab0","ab1"])

var primitiveToFactor = {};

// NB: note that there is no comma between outputVariable and inputVariableStr in the template
// this is because if inputVariableStr is empty, we don't want there to be an extraneous comma
// before it, so we handle this in the computation of inputVariableStr itself
// TODO: we eventually need to handle arguments for the variable constructor, e.g.,
// Discrete ab0 = new Discrete(0, 1, 5);
var factorTemplate = _.template(
    "{{type}} {{id}} = new {{type}}();\n" + 
        "myGraph.addFactor(new {{constructor}}( {{constructorArgStr}} ), {{outputVariable}} {{inputVariableStr}});")

var DimpleFactor = function(id, fn, args) {
    this.id  = id;
    
    var me = this; // alias for "this" that is safe to use inside map() 

    if (fn === 'random') {
        args = args.slice(); // copy the args array
        args.pop(); // remove the last variable, which should be a string containing "JSON.parse('null')"
    }

    this.args = args;

    if (typeof primitiveToFactor[fn] == "undefined") {
        try {
            primitiveToFactor[fn] = require('./dimple/factors/' + fn + '.js');
        } catch (e) {
            throw new Error("Can't yet translate function \""+fn+"\" to Dimple.");
        }
    }

    // call the function for adding the current factor's metadata (e.g., type, constructor)
    // to the this object
    (primitiveToFactor[fn])( this );

    if (typeof this.constructorArgs == 'undefined') {
        this.constructorArgs = [];
    } 
    this.constructorArgStr = this.constructorArgs.join(",")

    if (typeof this.inputVariables == 'undefined' || (Array.isArray(this.inputVariables) && this.inputVariables.length == 0)) {
        this.inputVariableStr = "";
    } else {
        this.inputVariableStr = ", " + this.inputVariables.join(", ");
    } 

    this.java = factorTemplate(this);
    
}
                 

module.exports =
{
traceToDimple: traceToDimple
}

