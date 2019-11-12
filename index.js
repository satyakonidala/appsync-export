#!/usr/bin/env node

/*
Description: Export appsync resolvers from AWS account as VTL files
*/

const program = require("commander");
const AWS = require("aws-sdk");
const fs = require("fs");
const { promisify } = require("util");
const path = require("path");

const mkdirPromise = promisify(fs.mkdir);
const fsWriteFilePromise = promisify(fs.writeFile);
const fsUnlinkPromise = promisify(fs.unlink);

program
  .version("0.1.0")
  .option("-a --api-id <required>", "API ID of the appsync API")
  .option("-p --profile <required>", "Required AWS Profile")
  .option("-r --aws-region <required>", "Required AWS Region")
  .option(
    "-o --output-dir [optional]",
    "Optional directory to save resolvers to, defaults to mappingTemplates"
  )
  .action(async function(req, optional) {
    if (!req.hasOwnProperty("apiId")) {
      console.error("ERROR: Missing appsync appid");
      process.exit(1);
    }

    const OUTPUT_DIR = req.outputDir || "./mappingTemplates";
    const RESOLVER_DIR = `${OUTPUT_DIR}/resolvers`;

    const API_ID = req.apiId;

    AWS.config.update({
      region: req.awsRegion || "us-east-1"
    });

    var credentials = new AWS.SharedIniFileCredentials({
      profile: req.profile
    });
    AWS.config.credentials = credentials;

    var appsync = new AWS.AppSync();

    let schemaDownloadParams = {
      apiId: API_ID,
      format: "SDL"
    };

    let typeListParams = {
      apiId: API_ID,
      format: "JSON",
      maxResults: 25,
      nextToken: null
    };

    const makeDirs = () => {
      const dirNames = ["Query", "Mutation"];
      return Promise.all(
        dirNames.map(dir =>
          mkdirPromise(path.resolve(`${RESOLVER_DIR}/${dir}`), {
            recursive: true
          })
        )
      );
    };

    const writeSchema = async schemaParams => {
      const schemaFileName = "schema.graphql";
      const schemaBlob = await appsync
        .getIntrospectionSchema(schemaParams)
        .promise();
      return fsWriteFilePromise(
        `${OUTPUT_DIR}/${schemaFileName}`,
        schemaBlob.schema
      );
    };

    const getApiTypes = async params => {
      const schemaTypes = [];
      const getTypesRecursive = async typeParams => {
        const partialTypesList = await appsync.listTypes(typeParams).promise();
        partialTypesList.types.map(type => schemaTypes.push(type.name));
        if (partialTypesList.nextToken !== null) {
          getTypesRecursive(
            Object.assign({}, typeParams, {
              nextToken: partialTypesList.nextToken
            })
          );
        }
      };
      await getTypesRecursive(params);

      return schemaTypes;
    };

    const getAllResolversForType = async typeName => {
      const resolversForType = [];

      const getResolversRecursive = async (typeName, nextToken) => {
        const partialResolverList = await appsync
          .listResolvers({
            apiId: API_ID,
            typeName: typeName,
            nextToken: nextToken
          })
          .promise();

        if (!partialResolverList.resolvers.length) {
          console.log(`no resolver for type:${typeName}`);
          return;
        }

        partialResolverList.resolvers.map(resolver =>
          resolversForType.push(resolver)
        );
        if (partialResolverList.nextToken !== null) {
          getResolversRecursive(typeName, partialResolverList.nextToken);
        }
      };

      await getResolversRecursive(typeName, null);

      return resolversForType;
    };

    let metaDataWritestream;
    //delete metadata file if present

    const startMetaDataStream = async () => {
      try {
        await fsUnlinkPromise(`${RESOLVER_DIR}/api-metadata.txt`);
        console.log("previous metadata flushed");
      } catch (e) {
      } finally {
        metaDataWritestream = fs.createWriteStream(
          `${RESOLVER_DIR}/api-metadata.txt`,
          {
            flags: "a"
          }
        );
      }
    };

    const writeMetaData = resolver => {
      metaDataWritestream.write(JSON.stringify(resolver) + "\n");
    };

    const getPipelineFunctions = async pipelineFunParms => {
      return appsync.getFunction(pipelineFunParms).promise();
    };

    const writeResolversToFile = async resolver => {
      const writeResolversToFilePromise = [];

      const filePathPartial = `${RESOLVER_DIR}/${resolver.typeName}/${resolver.fieldName}`;
      console.log(
        `writing resolvers for ${resolver.typeName}/${resolver.fieldName}`
      );

      // write metadata for each resolver
      writeMetaData(resolver);
      writeResolversToFilePromise.push(
        fsWriteFilePromise(
          `${filePathPartial}-requestMappingTemplate.vtl`,
          resolver.requestMappingTemplate
        ),
        fsWriteFilePromise(
          `${filePathPartial}-responseMappingTemplate.vtl`,
          resolver.responseMappingTemplate
        )
      );

      if (resolver.kind === "PIPELINE") {
        const pipelineFunctions = await Promise.all(
          resolver.pipelineConfig.functions.map(functionID =>
            getPipelineFunctions({ apiId: API_ID, functionId: functionID })
          )
        );

        pipelineFunctions.map(pipelineFunction => {
          console.log(
            `writing resolvers for Pipeline-function/${pipelineFunction.functionConfiguration.name}`
          );

          // write metadata for each resolver
          writeMetaData(pipelineFunction.functionConfiguration);
          writeResolversToFilePromise.push(
            fsWriteFilePromise(
              `${filePathPartial}-fun-${pipelineFunction.functionConfiguration.name}-requestMappingTemplate.vtl`,
              pipelineFunction.functionConfiguration.requestMappingTemplate
            ),
            fsWriteFilePromise(
              `${filePathPartial}-fun-${pipelineFunction.functionConfiguration.name}-responseMappingTemplate.vtl`,
              pipelineFunction.functionConfiguration.responseMappingTemplate
            )
          );
        });
      }

      return writeResolversToFilePromise;
    };

    // flatmap not supported in node10
    const flatMap = (xs, f) => xs.reduce((acc, x) => acc.concat(f(x)), []);

    const getResolvers = async () => {
      await Promise.all(
        flatMap(await getApiTypes(typeListParams), async typeName => {
          const resolversByType = await getAllResolversForType(typeName);

          if (!resolversByType.length) return;

          resolversByType.map(resolver => {
            writeResolversToFile(resolver);
          });
        })
      );
    };

    const startExport = async () => {
      await makeDirs();
      console.log("making dirs successful");
      await startMetaDataStream();
      await writeSchema(schemaDownloadParams);
      console.log("schema written to dir");
      await getResolvers();
    };

    try {
      await startExport();
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  });
program.parse(process.argv);
