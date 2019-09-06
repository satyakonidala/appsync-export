#!/usr/bin/env node

/*
Description: Export appsync resolvers from AWS account as VTL files
*/

const program = require("commander");
const AWS = require("aws-sdk");
const async = require("async");
const fs = require("fs");
const { promisify } = require("util");
const path = require("path");

const mkdirPromise = promisify(fs.mkdir);
const fsWritePromise = promisify(fs.writeFile);

program
  .version("0.0.1")
  .option("-a --api-id <required>", "API ID of the appsync API")
  .option("-p --profile <required>", "Required AWS Profile")
  .option("-r --aws-region <required>", "Required AWS Region")
  .option(
    "-o --output-dir [optional]",
    "Optional directory to save resolvers to, defaults to mappingTemplates"
  )
  .action(async function(req, optional) {
    if (!req.hasOwnProperty("apiId")) {
      console.log("ERROR! Missing required option api-ID, run -h for help");
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
      const dirNames = ["queries", "mutations"];
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

    const writeResolvers = async params => {
      // list all types available
      const schemaTypes = [];
      const getTypes = async typeParams => {
        const partialTypesList = await appsync.listTypes(typeParams).promise();
        partialTypesList.types.map(type => schemaTypes.push(type.name));
        if (partialTypesList.nextToken !== null) {
          getTypes(
            Object.assign({}, typeParams, {
              nextToken: partialTypesList.nextToken
            })
          );
        } else {
          return;
        }
      };

      await getTypes(params);

      // if (getTypes.nextToken !== null) {
      //   getTypes.types.map(type => schemaTypes.push(type.name));
      //   getTypes(Object.assign({}, params, { nextToken: getTypes.nextToken }));
      // }
      console.log(schemaTypes);
    };

    const startExport = async () => {
      // await makeDirs();
      // console.log("making dirs successful");
      // await writeSchema(schemaDownloadParams);
      // console.log("schema written to dir");

      await writeResolvers(typeListParams);
    };

    try {
      await startExport();
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  });
program.parse(process.argv);
