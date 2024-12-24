"use strict";

import exp from 'constants';

const parserHelpers = require('./utils/parserHelpers');
const utils = require('./utils/utils');
const fs = require('fs');
const parser = require('@solidity-parser/parser');
const graphviz = require('graphviz');
const { linearize } = require('c3-linearization');
const importer = require('../lib/utils/importer');

const {defaultColorScheme, defaultColorSchemeDark} = require('./utils/colorscheme');

export function graph(files, options = {}) {
  if (files.length === 0) {
    throw new Error(`\nNo files were specified for analysis in the arguments. Bailing...\n`);
  }

  let colorScheme = options.hasOwnProperty('colorScheme') ? options.colorScheme : defaultColorScheme;
  
  const digraph = graphviz.digraph('G');
  digraph.set('ratio', 'auto');
  digraph.set('page', '100');
  digraph.set('compound', 'true');
  colorScheme.digraph.bgcolor && digraph.set('bgcolor', colorScheme.digraph.bgcolor);
  for(let i in colorScheme.digraph.nodeAttribs){
    digraph.setNodeAttribut(i, colorScheme.digraph.nodeAttribs[i]);
  }
  for(let i in colorScheme.digraph.edgeAttribs){
    digraph.setEdgeAttribut(i, colorScheme.digraph.edgeAttribs[i]);
  }
  
  // make the files array unique by typecasting them to a Set and back
  // this is not needed in case the importer flag is on, because the 
  // importer module already filters the array internally
  if(!options.contentsInFilePath && options.importer) {
    files = importer.importProfiler(files);
  } else {
    files = [...new Set(files)];
  }

  // initialize vars that persist over file parsing loops
  let userDefinedStateVars = {};
  let stateVars = {};
  let dependencies = {};
  let fileASTs = [];
  let functionsPerContract = {'0_global':[]};
  let eventsPerContract = {'0_global':[]};
  let structsPerContract = {'0_global':[]};
  let contractUsingFor = {};
  let contractNames = ['0_global'];
  let customErrorNames = [];
  let content;

  for (let file of files) {
    if(!options.contentsInFilePath) {
      try {
        content = fs.readFileSync(file).toString('utf-8');
      } catch (e) {
        if (e.code === 'EISDIR') {
          console.error(`Skipping directory ${file}`);
          continue;
        } else {
          throw e;
        }
      }
    } else {
      content = file;
    }

    const ast = (() => {
      try {
        return parser.parse(content, {range: true});
      } catch (err) {
        if(!options.contentsInFilePath) {
          console.error(`\nError found while parsing the following file: ${file}\n`);
        } else {
          console.error(`\nError found while parsing one of the provided files\n`);
        }
        throw err;
      }
    })();

    fileASTs.push(ast);

    let contractName = '0_global';
    let cluster = null;
    userDefinedStateVars[contractName] = {};
    stateVars[contractName] = {};
    functionsPerContract[contractName] = [];
    eventsPerContract[contractName] = [];
    structsPerContract[contractName] = [];
    contractUsingFor[contractName] = {};

    parser.visit(ast, {
      ContractDefinition(node) {
        contractName = node.name;
        contractNames.push(contractName);
        
        let kind="";
        if (node.kind=="interface"){
          kind="  (iface)";
        } else if(node.kind=="library"){
          kind="  (lib)";
        }

        userDefinedStateVars[contractName] = {};
        stateVars[contractName] = {};
        functionsPerContract[contractName] = [];
        eventsPerContract[contractName] = [];
        structsPerContract[contractName] = [];
        contractUsingFor[contractName] = {};

        if(!(cluster = digraph.getCluster(`"cluster${contractName}"`))) {
          cluster = digraph.addCluster(`"cluster${contractName}"`);

          cluster.set('label', contractName + kind);
          cluster.set('color', colorScheme.contract.defined.color);
          if(colorScheme.contract.defined.fontcolor){
            cluster.set('fontcolor', colorScheme.contract.undefined.fontcolor);
          }
          
          if (colorScheme.contract.defined.style) {
            cluster.set('style', colorScheme.contract.defined.style || "filled");
            cluster.set('bgcolor', colorScheme.contract.defined.color);
          } else {
            cluster.set('style', 'filled');
          }

          colorScheme.contract.defined.bgcolor && cluster.set('bgcolor', colorScheme.contract.defined.bgcolor);
          
        } else {
          if (colorScheme.contract.defined.style) {
            cluster.set('style', colorScheme.contract.defined.style);
          } else {
            cluster.set('style', 'filled');
          } 
        }
        
        dependencies[contractName] = node.baseContracts.map(spec =>
          spec.baseName.namePath
        );

        dependencies[contractName].unshift('0_global');
      },

      'ContractDefinition:exit': function(node) {
        contractName = '0_global';
      },

      StateVariableDeclaration(node) {
        for (let variable of node.variables) {
          if (parserHelpers.isUserDefinedDeclaration(variable)) {
            userDefinedStateVars[contractName][variable.name] = variable.typeName.namePath;
          } else if (parserHelpers.isElementaryTypeDeclaration(variable)) {
            stateVars[contractName][variable.name] = variable.typeName.name;
          } else if (parserHelpers.isArrayDeclaration(variable)) {
            stateVars[contractName][variable.name] = variable.typeName.baseTypeName.namePath;
          } else if (parserHelpers.isMappingDeclaration(variable)) {
            stateVars[contractName][variable.name] = variable.typeName.valueType.name;
          }
        }
      },

      FunctionDefinition(node) {
        functionsPerContract[contractName].push(node.name);
      },

      CustomErrorDefinition(node) {
        functionsPerContract[contractName].push(node.name);
        customErrorNames.push(node.name);
      },

      EventDefinition(node) {
        eventsPerContract[contractName].push(node.name);
      },

      StructDefinition(node) {
        structsPerContract[contractName].push(node.name);
      },

      UsingForDeclaration(node) {
        let typeNameName = '*';
        // Check if the using for declaration is targeting a specific type or all types with "*"
        if(node.typeName != null && node.typeName.hasOwnProperty('name')){
          typeNameName = node.typeName.name;
        } else if(node.typeName != null && node.typeName.hasOwnProperty('namePath')){
          typeNameName = node.typeName.namePath;
        }

        if(!contractUsingFor[contractName][typeNameName]){
          contractUsingFor[contractName][typeNameName] = new Set([]);
        }
        contractUsingFor[contractName][typeNameName].add(node.libraryName);
      }
    });
  }

  dependencies = linearize(dependencies, {reverse: true});

  for (let ast of fileASTs) {

    let contractName = '0_global';
    let cluster = null;

    function nodeName(functionName, contractName) {
      if (
        functionName !== '<Fallback>' && functionName !== '<Receive Ether>' && functionName !== '<Constructor>'
        && dependencies.hasOwnProperty(contractName)
      ) {
        for (let dep of dependencies[contractName]) {
          const name = `${dep}.${functionName}`;
          if (digraph.getNode(name)) {
            return name;
          }
        }
      }

      return `${contractName}.${functionName}`;
    }

    function functionName(node) {
      let name;
      if (node.isConstructor) {
        name = '<Constructor>';
      } else if (node.isFallback) {
        name = '<Fallback>';
      } else if (node.isReceiveEther) {
        name = '<Receive Ether>';
      } else {
        name = node.name;
      }

      return name;
    }

    parser.visit(ast, {
      ContractDefinition(node) {
        contractName = node.name;

        cluster = digraph.getCluster(`"cluster${contractName}"`);
      },

      'ContractDefinition:exit': function(node) {
        contractName = '0_global';
      },

      FunctionDefinition(node) {
        const name = functionName(node);

        let opts = { label: name };

        if (node.visibility === 'public' || node.visibility === 'default') {
          opts.color = colorScheme.visibility.public;
        } else if (node.visibility === 'external') {
          opts.color = colorScheme.visibility.external;
        } else if (node.visibility === 'private') {
          opts.color = colorScheme.visibility.private;
        } else if (node.visibility === 'internal') {
          opts.color = colorScheme.visibility.internal;
        }

        if(colorScheme.visibility.isFilled){
          if(node.stateMutability==="payable"){
            opts.fillcolor = opts.color;
            opts.color = colorScheme.nodeType.payable;
          } else {
            opts.fillcolor = opts.color;
          }
        }
        
        if(cluster == null)
          return;
        
        cluster.addNode(nodeName(name, contractName), opts);
      },

      ModifierDefinition(node) {
        const name = node.name;

        let opts = {
          label: name,
          color: colorScheme.nodeType.modifier
        };
        if(colorScheme.nodeType.isFilled){
          opts.fillcolor = opts.color;
        }
        if(colorScheme.nodeType.shape){
          opts.shape = colorScheme.nodeType.shape;
        }

        cluster.addNode(nodeName(name, contractName), opts);
      }
    });

    let callingScope = null;
    let userDefinedLocalVars = {};
    let localVars = {};
    let tempUserDefinedStateVars = {};
    let tempStateVars = {};
    let eventDefinitions = [];

    parser.visit(ast, {
      ContractDefinition(node) {
        contractName = node.name;

        for (let dep of dependencies[contractName]) {
          Object.assign(tempUserDefinedStateVars, userDefinedStateVars[dep]);
          Object.assign(tempStateVars, stateVars[dep]);
        }

        Object.assign(tempUserDefinedStateVars, userDefinedStateVars[contractName]);
        Object.assign(tempStateVars, stateVars[contractName]);
      },

      EventDefinition(node) {
        eventDefinitions.push(node.name);
      },

      'ContractDefinition:exit': function(node) {
        contractName = '0_global'; 
        tempUserDefinedStateVars = {};
        tempStateVars = {};
      },

      FunctionDefinition(node) {
        const name = functionName(node);

        callingScope = nodeName(name, contractName);
      },

      'FunctionDefinition:exit': function(node) {
        callingScope = null; 
        userDefinedLocalVars = {};
        localVars = {};
      },

      ModifierDefinition(node) {
        callingScope = nodeName(node.name, contractName);
      },

      'ModifierDefinition:exit': function(node) {
        callingScope = null;
      },

      ParameterList(node) {
        for (let parameter of node.parameters) {
          if (parameter.name === null) {
            return;
          } else if (parserHelpers.isUserDefinedDeclaration(parameter)) {
            userDefinedLocalVars[parameter.name] = parameter.typeName.namePath;
          } else if (callingScope) {
            localVars[parameter.name] = parameter.typeName.name;
          }
        }
      },

      VariableDeclaration(node) {
        if (callingScope && node.name === null) {
          return;
        } else if (callingScope && parserHelpers.isUserDefinedDeclaration(node)) {
          userDefinedLocalVars[node.name] = node.typeName.namePath;
        } else if (callingScope && parserHelpers.isElementaryTypeDeclaration(node)) {
          localVars[node.name] = node.typeName.name;
        } else if (callingScope && parserHelpers.isArrayDeclaration(node)) {
          localVars[node.name] = node.typeName.baseTypeName.namePath;
        } else if (callingScope && parserHelpers.isMappingDeclaration(node)) {
          localVars[node.name] = node.typeName.valueType.name;
        }
      },

      ModifierInvocation(node) {
        if (options.enableModifierEdges && callingScope) {
          digraph.addEdge(callingScope, nodeName(node.name, contractName), { color: 'yellow' });
        }
      },

      FunctionCall(node) {
        if (!callingScope) {
          // this is a function call outside of functions and modifiers, ignore for now
          return;
        }

        const expr = node.expression;

        let name;
        let localContractName = contractName;
        let opts = {
          color: colorScheme.call.default
        };

        // Construct an array with the event and struct names in the whole dependencies tree of the current contract
        let eventsOfDependencies = [];
        let structsOfDependencies = [];
        if (dependencies.hasOwnProperty(contractName)) {
          for (let dep of dependencies[contractName]) {
            eventsOfDependencies = eventsOfDependencies.concat(eventsPerContract[dep]);
            structsOfDependencies = structsOfDependencies.concat(structsPerContract[dep]);
          }
        }
        
        if(
          parserHelpers.isRegularFunctionCall(node, contractNames, eventsOfDependencies, structsOfDependencies, customErrorNames)
        ) {
          opts.color = colorScheme.call.regular;
          name = expr.name;
        } else if(customErrorNames.includes(node.expression.name)) {
          opts.color = colorScheme.call.error;
          name = expr.name;
        } else if(parserHelpers.isMemberAccess(node)) {
          let object = null;
          let variableType = null;

          name = expr.memberName;
          
          // checking if the member expression is a simple identifier
          if(expr.expression.hasOwnProperty('name')) {
            object = expr.expression.name;
          // checking if it is a member of `address` and pass along it's contents
          } else if(parserHelpers.isMemberAccessOfAddress(node)) {
            if(name === 'call') {
              if(node.arguments !== undefined && node.arguments.length > 0) {
                name = content.substring(node.arguments[0].range[0], node.arguments[0].range[1]+1).replace(/"/g,"");
              } else {
                name = '<Fallback>';
              }
            }

            if(expr.expression.arguments[0].hasOwnProperty('name')) {
              object = expr.expression.arguments[0].name;
            } else if(expr.expression.arguments[0].type === 'NumberLiteral') {
              object = 'address('+expr.expression.arguments[0].number+')';
            } else {
              object = content.substring(expr.expression.arguments[0].range[0], expr.expression.arguments[0].range[1]+1).replace(/"/g,"");
            }

          // checking if it is a typecasting to a user-defined contract type
          } else if(parserHelpers.isAContractTypecast(node, contractNames)) {
            object = expr.expression.expression.name;
          }

          // check if member expression is a special var and get its canonical type
          if(parserHelpers.isSpecialVariable(expr.expression)) {
            variableType = parserHelpers.getSpecialVariableType(expr.expression);

          // check if member expression is a typecast for a canonical type
          } else if(parserHelpers.isElementaryTypecast(expr.expression)) {
            variableType = expr.expression.expression.typeName.name;

          // else check for vars in defined the contract
          } else {
            // check if member access is a function of a "using for" declaration
            // START
            if(localVars.hasOwnProperty(object)) {
              variableType = localVars[object];
            } else if(userDefinedLocalVars.hasOwnProperty(object)) {
              variableType = userDefinedLocalVars[object];
            } else if(tempUserDefinedStateVars.hasOwnProperty(object)) {
              variableType = tempUserDefinedStateVars[object];
            } else if(tempStateVars.hasOwnProperty(object)) {
              variableType = tempStateVars[object];
            }
          }

          // convert to canonical elementary type: uint -> uint256
          variableType = variableType === 'uint' ? 'uint256' : variableType;

          // if variable type is not null let's replace "object" for the actual library name
          if (variableType !== null) {
            // Incase there is a "using for" declaration for this specific variable type we get its definition
            if (contractUsingFor[contractName].hasOwnProperty(variableType) &&
              functionsPerContract.hasOwnProperty(contractUsingFor[contractName][variableType])) {

              // If there were any library declarations done to all the types with "*"
              // we will add them to the list of matching contracts
              let contractUsingForDefinitions = new Set(...contractUsingFor[contractName][variableType]);
              if (contractUsingFor[contractName].hasOwnProperty('*') &&
                functionsPerContract.hasOwnProperty(contractUsingFor[contractName]['*'])) {
                  contractUsingForDefinitions = new Set(...contractUsingFor[contractName][variableType], ...contractUsingFor[contractName]['*']);
              }

              // check which usingFor contract the method resolves to (best effort first match)
              let matchingContracts = [...contractUsingForDefinitions].filter(contract => functionsPerContract[contract] != undefined ? functionsPerContract[contract].includes(name) : false);
            
              if(matchingContracts.length > 0){
                // we found at least one matching contract. use the first. don't know what to do if multiple are matching :/
                if (!options.libraries) {
                  object = matchingContracts[0];
                } else {
                  return;
                }
              }
            }
          // In case there is not, we can just shortcircuit the search to only the "*" variable type, incase it exists
          } else if (contractUsingFor[contractName].hasOwnProperty('*') &&
          functionsPerContract.hasOwnProperty(contractUsingFor[contractName]['*'])) {
            // check which usingFor contract the method resolves to (best effort first match)
            let matchingContracts = [...contractUsingFor[contractName]['*']].filter(contract => functionsPerContract[contract] != undefined ? functionsPerContract[contract].includes(name) : false);
            
            if(matchingContracts.length > 0){
              // we found at least one matching contract. use the first. don't know what to do if multiple are matching :/
              if (!options.libraries) {
                object = matchingContracts[0];
              } else {
                return;
              }
            }
          }
          // END

          // if we have found nothing so far then create no node
          if(object === null) {
            return;
          } else if(object === 'this') {
            opts.color = colorScheme.call.this;
          } else if (object === 'super') {
            let matchingContracts = [...dependencies[contractName]].filter(contract => functionsPerContract[contract] != undefined ? functionsPerContract[contract].includes(name) : false);

            if(matchingContracts.length > 0){
              localContractName = matchingContracts[0];
            } else {
              return;
            }
          } else if (tempUserDefinedStateVars[object] !== undefined) {
            localContractName = tempUserDefinedStateVars[object];
          } else if (userDefinedLocalVars[object] !== undefined) {
            localContractName = userDefinedLocalVars[object];
          } else {
            localContractName = object;
          }

        } else {
          return;
        }

        let externalCluster;

        if(!(externalCluster = digraph.getCluster(`"cluster${localContractName}"`))) {
          externalCluster = digraph.addCluster(`"cluster${localContractName}"`);

          externalCluster.set('label', localContractName);
          externalCluster.set('color', colorScheme.contract.undefined.color);
          if(colorScheme.contract.undefined.fontcolor){
            externalCluster.set('fontcolor', colorScheme.contract.undefined.fontcolor);
          }
          if(colorScheme.contract.undefined.style){
            externalCluster.set('style', colorScheme.contract.undefined.style || "filled");
            colorScheme.contract.undefined.bgcolor && externalCluster.set('bgcolor', colorScheme.contract.undefined.bgcolor );
          } 
        }
        

        let localNodeName = nodeName(name, localContractName);

        if (!digraph.getNode(localNodeName) && externalCluster) {
          let _opts = {
            label: name
          };
          if(eventDefinitions.includes(name)){
            if(colorScheme.event){
              _opts = colorScheme.event;
            } else {
              _opts.style = 'dotted';
            }
            
          } else if (customErrorNames.includes(node.expression.name)) {
            if(colorScheme.event){
              _opts = colorScheme.error;
            } else {
              _opts.color = 'brown2';
              _opts.shape = 'box';
            }
          }
          externalCluster.addNode(localNodeName, _opts);
        }

        digraph.addEdge(callingScope, localNodeName, opts);
      }
    });
  }

  // This next block's purpose is to create a legend on the lower left corner
  // of the graph with color information.
  // We'll do it in dot, by hand, because it's overkill to do it programatically.
  // 
  // We'll have to paste this subgraph before the last curly bracket of the diagram
  
  let legendDotString = `

rankdir=LR
node [shape=plaintext]
subgraph cluster_01 { 
label = "Legend";
key [label=<<table border="0" cellpadding="2" cellspacing="0" cellborder="0">
  <tr><td align="right" port="i1">Internal Call</td></tr>
  <tr><td align="right" port="i2">External Call</td></tr>
  <tr><td align="right" port="i2">Custom Error Call</td></tr>
  <tr><td align="right" port="i3">Defined Contract</td></tr>
  <tr><td align="right" port="i4">Undefined Contract</td></tr>
  </table>>]
key2 [label=<<table border="0" cellpadding="2" cellspacing="0" cellborder="0">
  <tr><td port="i1">&nbsp;&nbsp;&nbsp;</td></tr>
  <tr><td port="i2">&nbsp;&nbsp;&nbsp;</td></tr>
  <tr><td port="i3" bgcolor="${colorScheme.contract.defined.bgcolor}">&nbsp;&nbsp;&nbsp;</td></tr>
  <tr><td port="i4">
    <table border="1" cellborder="0" cellspacing="0" cellpadding="7" color="${colorScheme.contract.undefined.color}">
      <tr>
       <td></td>
      </tr>
     </table>
  </td></tr>
  </table>>]
key:i1:e -> key2:i1:w [color="${colorScheme.call.regular}"]
key:i2:e -> key2:i2:w [color="${colorScheme.call.default}"]
key:i2:e -> key2:i2:w [color="${colorScheme.call.error}"]
}
`;
  let finalDigraph = utils.insertBeforeLastOccurrence(digraph.to_dot(), '}', legendDotString);

  return finalDigraph;
}
