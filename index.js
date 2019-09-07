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
const fsWritePromise = promisify(fs.writeFile);

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
          mkdirPromise(path.resolve(`${OUTPUT_DIR}/${dir}`), {
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
      return fsWritePromise(
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

    const writeResolversToFile = resolver => {
      const filePathPartial = `${OUTPUT_DIR}/${resolver.typeName}/${resolver.fieldName}`;
      return [
        fsWritePromise(
          `${filePathPartial}-requestMappingTemplate.vtl`,
          resolver.requestMappingTemplate
        ),
        fsWritePromise(
          `${filePathPartial}-responseMappingTemplate.vtl`,
          resolver.responseMappingTemplate
        )
      ];
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
