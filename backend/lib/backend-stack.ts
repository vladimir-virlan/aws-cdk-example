import { Stack, StackProps } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { aws_s3 as s3 } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Table, AttributeType, StreamViewType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';

import { CfnGraphQLApi, CfnApiKey, CfnGraphQLSchema, CfnDataSource, CfnResolver, } from 'aws-cdk-lib/aws-appsync';
import { Role, ServicePrincipal, ManagedPolicy } from 'aws-cdk-lib/aws-iam';


export class BackendStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    new s3.Bucket(this, 'BlogImages', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    // This code will create a Cognito User Pool that will enable the user to sign in with a username, email address, and password.
    const userPool = new cognito.UserPool(this, 'blog-user-pool', {
      selfSignUpEnabled: true,
      accountRecovery: cognito.AccountRecovery.PHONE_AND_EMAIL,
      userVerification: {
        emailStyle: cognito.VerificationEmailStyle.CODE
      },
      autoVerify: {
        email: true
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true
        }
      }
    });

    //A userPoolClient will also be created enabling client applications to interact with the service.
    const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool
    });

    const tableName = 'posts'

    const postsGraphQLApi = new CfnGraphQLApi(this, 'PostsApi', {
      name: 'posts-api',
      authenticationType: 'API_KEY',
    });

    new CfnApiKey(this, 'PostsApiKey', {
      apiId: postsGraphQLApi.attrApiId
    });


    const apiSchema = new CfnGraphQLSchema(this, 'PostsSchema', {
      apiId: postsGraphQLApi.attrApiId,
      definition: `type ${tableName} {
        ${tableName}Id: ID!
        name: String
      }
      type Paginated${tableName} {
        items: [${tableName}!]!
        nextToken: String
      }
      type Query {
        all(limit: Int, nextToken: String): Paginated${tableName}!
        getOne(${tableName}Id: ID!): ${tableName}
      }
      type Mutation {
        save(name: String!): ${tableName}
        delete(${tableName}Id: ID!): ${tableName}
      }
      type Schema {
        query: Query
        mutation: Mutation
      }`
    });

    const postsTable = new Table(this, 'PostsTable', {
      tableName: tableName,
      partitionKey: {
        name: `${tableName}Id`,
        type: AttributeType.STRING
      },
      billingMode: BillingMode.PAY_PER_REQUEST,
      stream: StreamViewType.NEW_IMAGE,

      // The default removal policy is RETAIN, which means that cdk destroy will not attempt to delete
      // the new table, and it will remain in your account until manually deleted. By setting the policy to
      // DESTROY, cdk destroy will delete the table (even if it has data in it)
      removalPolicy: cdk.RemovalPolicy.DESTROY, // NOT recommended for production code
    });


    const postsTableRole = new Role(this, 'PostsDynamoDBRole', {
      assumedBy: new ServicePrincipal('appsync.amazonaws.com')
    });
    postsTableRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('AmazonDynamoDBFullAccess'));



    const dataSource = new CfnDataSource(this, 'PostsDataSource', {
      apiId: postsGraphQLApi.attrApiId,
      name: 'PostsDynamoDataSource',
      type: 'AMAZON_DYNAMODB',
      dynamoDbConfig: {
        tableName: postsTable.tableName,
        awsRegion: this.region
      },
      serviceRoleArn: postsTableRole.roleArn
    });


    const getOneResolver = new CfnResolver(this, 'GetOneQueryResolver', {
      apiId: postsGraphQLApi.attrApiId,
      typeName: 'Query',
      fieldName: 'getOne',
      dataSourceName: dataSource.name,
      requestMappingTemplate: `{
        "version": "2017-02-28",
        "operation": "GetItem",
        "key": {
          "${tableName}Id": $util.dynamodb.toDynamoDBJson($ctx.args.${tableName}Id)
        }
      }`,
      responseMappingTemplate: `$util.toJson($ctx.result)`
    });
    getOneResolver.addDependsOn(apiSchema);

    const getAllResolver = new CfnResolver(this, 'GetAllQueryResolver', {
      apiId: postsGraphQLApi.attrApiId,
      typeName: 'Query',
      fieldName: 'all',
      dataSourceName: dataSource.name,
      requestMappingTemplate: `{
        "version": "2017-02-28",
        "operation": "Scan",
        "limit": $util.defaultIfNull($ctx.args.limit, 20),
        "nextToken": $util.toJson($util.defaultIfNullOrEmpty($ctx.args.nextToken, null))
      }`,
      responseMappingTemplate: `$util.toJson($ctx.result)`
    });
    getAllResolver.addDependsOn(apiSchema);

    const saveResolver = new CfnResolver(this, 'SaveMutationResolver', {
      apiId: postsGraphQLApi.attrApiId,
      typeName: 'Mutation',
      fieldName: 'save',
      dataSourceName: dataSource.name,
      requestMappingTemplate: `{
        "version": "2017-02-28",
        "operation": "PutItem",
        "key": {
          "${tableName}Id": { "S": "$util.autoId()" }
        },
        "attributeValues": {
          "name": $util.dynamodb.toDynamoDBJson($ctx.args.name)
        }
      }`,
      responseMappingTemplate: `$util.toJson($ctx.result)`
    });
    saveResolver.addDependsOn(apiSchema);

    const deleteResolver = new CfnResolver(this, 'DeleteMutationResolver', {
      apiId: postsGraphQLApi.attrApiId,
      typeName: 'Mutation',
      fieldName: 'delete',
      dataSourceName: dataSource.name,
      requestMappingTemplate: `{
        "version": "2017-02-28",
        "operation": "DeleteItem",
        "key": {
          "${tableName}Id": $util.dynamodb.toDynamoDBJson($ctx.args.${tableName}Id)
        }
      }`,
      responseMappingTemplate: `$util.toJson($ctx.result)`
    });
    deleteResolver.addDependsOn(apiSchema);

    // // Functions resolvers:
    // const productLambda = new lambda.Function(this, 'AppSyncProductHandler', {
    //   runtime: lambda.Runtime.NODEJS_14_X,
    //   handler: 'main.handler',
    //   code: lambda.Code.fromAsset('lambda-fns'),
    //   memorySize: 1024
    // });






    // const lambdaDs = api.addLambdaDataSource('lambdaDataSource', productLambda);


    // lambdaDs.createResolver({
    //   typeName: "Query",
    //   fieldName: "getProductById"
    // })

    // lambdaDs.createResolver({
    //   typeName: "Query",
    //   fieldName: "listProducts"
    // })

    // lambdaDs.createResolver({
    //   typeName: "Query",
    //   fieldName: "productsByCategory"
    // })

    // lambdaDs.createResolver({
    //   typeName: "Mutation",
    //   fieldName: "createProduct"
    // })

    // lambdaDs.createResolver({
    //   typeName: "Mutation",
    //   fieldName: "deleteProduct"
    // })

    // lambdaDs.createResolver({
    //   typeName: "Mutation",
    //   fieldName: "updateProduct"
    // });

    // const productTable = new ddb.Table(this, 'CDKProductTable', {
    //   billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    //   partitionKey: {
    //     name: 'id',
    //     type: ddb.AttributeType.STRING,
    //   },
    // });

    // productTable.addGlobalSecondaryIndex({
    //   indexName: "productsByCategory",
    //   partitionKey: {
    //     name: "category",
    //     type: ddb.AttributeType.STRING,
    //   }
    // });

    // //Enable the Lambda function access to dynamo DB table using IAM
    // productTable.grantFullAccess(productLambda);








  }
}
