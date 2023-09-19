/**
 *  Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */
import * as cdk from 'aws-cdk-lib';
import { pascalCase } from 'change-case';
import { Construct } from 'constructs';
import * as path from 'path';

import {
  IdentityCenterAssignmentConfig,
  IdentityCenterConfig,
  IdentityCenterPermissionSetConfig,
  RoleConfig,
  RoleSetConfig,
} from '@aws-accelerator/config';
import {
  BudgetDefinition,
  Inventory,
  KeyLookup,
  LimitsDefinition,
  UsersGroupsMetadata,
  WarmAccount,
} from '@aws-accelerator/constructs';
import { AcceleratorStack, AcceleratorStackProps, NagSuppressionRuleIds } from './accelerator-stack';

export interface OperationsStackProps extends AcceleratorStackProps {
  readonly accountWarming: boolean;
}

interface PermissionSetMapping {
  name: string;
  arn: string;
  permissionSet: cdk.aws_sso.CfnPermissionSet;
}

export class OperationsStack extends AcceleratorStack {
  /**
   * List of all the defined SAML Providers
   */
  private providers: { [name: string]: cdk.aws_iam.SamlProvider } = {};

  /**
   * List of all the defined IAM Policies
   */
  private policies: { [name: string]: cdk.aws_iam.ManagedPolicy } = {};

  /**
   * List of all the defined IAM Roles
   */
  private roles: { [name: string]: cdk.aws_iam.Role } = {};

  /**
   * List of all the defined IAM Groups
   */
  private groups: { [name: string]: cdk.aws_iam.Group } = {};

  /**
   * List of all the defined IAM Users
   */
  private users: { [name: string]: cdk.aws_iam.User } = {};

  /**
   * KMS Key used to encrypt CloudWatch logs
   */
  private cloudwatchKey: cdk.aws_kms.Key;

  /**
   * Constructor for OperationsStack
   *
   * @param scope
   * @param id
   * @param props
   */
  constructor(scope: Construct, id: string, props: OperationsStackProps) {
    super(scope, id, props);

    this.nagSuppressionInputs = [];

    this.cloudwatchKey = cdk.aws_kms.Key.fromKeyArn(
      this,
      'AcceleratorGetCloudWatchKey',
      cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        this.acceleratorResourceNames.parameters.cloudWatchLogCmkArn,
      ),
    ) as cdk.aws_kms.Key;

    // Security Services delegated admin account configuration
    // Global decoration for security services
    const securityAdminAccount = props.securityConfig.centralSecurityServices.delegatedAdminAccount;
    const securityAdminAccountId = props.accountsConfig.getAccountId(securityAdminAccount);

    //
    // Only deploy IAM and CUR resources into the home region
    //
    if (props.globalConfig.homeRegion === cdk.Stack.of(this).region) {
      this.addProviders();
      this.addManagedPolicies();
      this.addRoles();
      this.addGroups();
      this.addUsers();
      this.createStackSetRoles();
      // Identity Center
      //
      this.addIdentityCenterResources(securityAdminAccountId);
      //
      //
      // Budgets
      //
      this.enableBudgetReports();
      //
      // Service Quota Limits
      //
      this.increaseLimits();

      // Create Accelerator Access Role in every region
      this.createAssetAccessRole();

      // Create Cross Account Service Catalog Role
      this.createServiceCatalogPropagationRole();

      // warm account here
      this.warmAccount(props.accountWarming);
    }

    //
    // Backup Vaults
    //
    this.addBackupVaults();

    if (
      this.props.globalConfig.ssmInventory?.enable &&
      this.isIncluded(this.props.globalConfig.ssmInventory.deploymentTargets)
    ) {
      this.enableInventory();
    }

    //
    // Create SSM parameters
    //
    this.createSsmParameters();

    //
    // Create NagSuppressions
    //
    this.addResourceSuppressionsByPath(this.nagSuppressionInputs);

    this.logger.info('Completed stack synthesis');
  }

  /* Enable AWS Service Quota Limits
   *
   */
  private increaseLimits() {
    for (const limit of this.props.globalConfig.limits ?? []) {
      if (this.isIncluded(limit.deploymentTargets ?? [])) {
        this.logger.info(`Updating limits for provided services.`);
        new LimitsDefinition(this, `ServiceQuotaUpdates${limit.quotaCode}` + `${limit.desiredValue}`, {
          serviceCode: limit.serviceCode,
          quotaCode: limit.quotaCode,
          desiredValue: limit.desiredValue,
          kmsKey: this.cloudwatchKey,
          logRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
        });
      }
    }
  }

  /**
   * Adds SAML Providers
   */
  private addProviders() {
    for (const providerItem of this.props.iamConfig.providers ?? []) {
      this.logger.info(`Add Provider ${providerItem.name}`);
      this.providers[providerItem.name] = new cdk.aws_iam.SamlProvider(
        this,
        `${pascalCase(providerItem.name)}SamlProvider`,
        {
          name: providerItem.name,
          metadataDocument: cdk.aws_iam.SamlMetadataDocument.fromFile(
            path.join(this.props.configDirPath, providerItem.metadataDocument),
          ),
        },
      );
    }
  }

  /**
   * Adds IAM Managed Policies
   */
  private addManagedPolicies() {
    for (const policySetItem of this.props.iamConfig.policySets ?? []) {
      if (!this.isIncluded(policySetItem.deploymentTargets) || policySetItem.identityCenterDependency) {
        this.logger.info(`Item excluded`);
        continue;
      }

      for (const policyItem of policySetItem.policies) {
        this.logger.info(`Add customer managed policy ${policyItem.name}`);

        // Read in the policy document which should be properly formatted json
        const policyDocument = JSON.parse(
          this.generatePolicyReplacements(
            path.join(this.props.configDirPath, policyItem.policy),
            false,
            this.organizationId,
          ),
        );

        // Create a statements list using the PolicyStatement factory
        const statements: cdk.aws_iam.PolicyStatement[] = [];
        for (const statement of policyDocument.Statement) {
          statements.push(cdk.aws_iam.PolicyStatement.fromJson(statement));
        }

        // Construct the ManagedPolicy
        this.policies[policyItem.name] = new cdk.aws_iam.ManagedPolicy(this, pascalCase(policyItem.name), {
          managedPolicyName: policyItem.name,
          statements,
        });

        // AwsSolutions-IAM5: The IAM entity contains wildcard permissions and does not have a cdk_nag rule suppression with evidence for those permission
        // rule suppression with evidence for this permission.
        this.nagSuppressionInputs.push({
          id: NagSuppressionRuleIds.IAM5,
          details: [
            {
              path: `${this.stackName}/${pascalCase(policyItem.name)}/Resource`,
              reason: 'Policies definition are derived from accelerator iam-config boundary-policy file',
            },
          ],
        });
      }
    }
  }

  /**
   * Generates the list of role principals for the provided roleItem
   *
   * @param roleItem
   * @returns List of cdk.aws_iam.PrincipalBase
   */
  private getRolePrincipals(roleItem: RoleConfig): cdk.aws_iam.PrincipalBase[] {
    const principals: cdk.aws_iam.PrincipalBase[] = [];

    for (const assumedByItem of roleItem.assumedBy ?? []) {
      this.logger.info(`Role - assumed by type(${assumedByItem.type}) principal(${assumedByItem.principal})`);

      switch (assumedByItem.type) {
        case 'service':
          principals.push(new cdk.aws_iam.ServicePrincipal(assumedByItem.principal));
          break;
        case 'account':
          const partition = this.props.partition;
          const accountIdRegex = /^\d{12}$/;
          const accountArnRegex = new RegExp('^arn:' + partition + ':iam::(\\d{12}):root$');

          if (accountIdRegex.test(assumedByItem.principal)) {
            principals.push(new cdk.aws_iam.AccountPrincipal(assumedByItem.principal));
          } else if (accountArnRegex.test(assumedByItem.principal)) {
            const accountId = accountArnRegex.exec(assumedByItem.principal);
            principals.push(new cdk.aws_iam.AccountPrincipal(accountId![1]));
          } else {
            principals.push(
              new cdk.aws_iam.AccountPrincipal(this.props.accountsConfig.getAccountId(assumedByItem.principal)),
            );
          }
          break;
        case 'provider':
          // workaround due to https://github.com/aws/aws-cdk/issues/22091
          if (this.props.partition === 'aws-cn') {
            principals.push(
              new cdk.aws_iam.FederatedPrincipal(
                this.providers[assumedByItem.principal].samlProviderArn,
                {
                  StringEquals: {
                    'SAML:aud': 'https://signin.amazonaws.cn/saml',
                  },
                },
                'sts:AssumeRoleWithSAML',
              ),
            );
          } else {
            principals.push(new cdk.aws_iam.SamlConsolePrincipal(this.providers[assumedByItem.principal]));
          }
          break;
      }
    }

    return principals;
  }

  /**
   * Generates the list of managed policies for the provided roleItem
   *
   * @param roleItem
   * @returns List of cdk.aws_iam.IManagedPolicy
   */
  private getManagedPolicies(roleItem: RoleConfig): cdk.aws_iam.IManagedPolicy[] {
    const managedPolicies: cdk.aws_iam.IManagedPolicy[] = [];

    for (const policyItem of roleItem.policies?.awsManaged ?? []) {
      this.logger.info(`Role - aws managed policy ${policyItem}`);
      managedPolicies.push(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(policyItem));
    }
    for (const policyItem of roleItem.policies?.customerManaged ?? []) {
      this.logger.info(`Role - customer managed policy ${policyItem}`);
      managedPolicies.push(this.policies[policyItem]);
    }

    return managedPolicies;
  }

  /**
   * Create IAM role
   * @param roleItem {@link RoleConfig}
   * @param roleSetItem {@link RoleSetConfig}
   * @returns role {@link cdk.aws_iam.Role}
   */
  private createRole(roleItem: RoleConfig, roleSetItem: RoleSetConfig): cdk.aws_iam.Role {
    const principals = this.getRolePrincipals(roleItem);
    const managedPolicies = this.getManagedPolicies(roleItem);
    let assumedBy: cdk.aws_iam.IPrincipal;
    if (roleItem.assumedBy.find(item => item.type === 'provider')) {
      // Since a SamlConsolePrincipal creates conditions, we can not
      // use the CompositePrincipal. Verify that it is alone
      if (principals.length > 1) {
        this.logger.error('More than one principal found when adding provider');
        throw new Error(`Configuration validation failed at runtime.`);
      }
      assumedBy = principals[0];
    } else {
      assumedBy = new cdk.aws_iam.CompositePrincipal(...principals);
    }

    const role = new cdk.aws_iam.Role(this, pascalCase(roleItem.name), {
      roleName: roleItem.name,
      assumedBy,
      managedPolicies,
      path: roleSetItem.path,
      permissionsBoundary: this.policies[roleItem.boundaryPolicy],
    });

    // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
    // rule suppression with evidence for this permission.
    this.nagSuppressionInputs.push({
      id: NagSuppressionRuleIds.IAM4,
      details: [
        {
          path: `${this.stackName}/${pascalCase(roleItem.name)}/Resource`,
          reason: 'IAM Role created as per accelerator iam-config needs AWS managed policy',
        },
      ],
    });

    return role;
  }

  /**
   * Adds IAM Roles
   */
  private addRoles() {
    for (const roleSetItem of this.props.iamConfig.roleSets ?? []) {
      if (!this.isIncluded(roleSetItem.deploymentTargets)) {
        this.logger.info(`Item excluded`);
        continue;
      }

      for (const roleItem of roleSetItem.roles) {
        this.logger.info(`Add role ${roleItem.name}`);

        // Create IAM role
        const role = this.createRole(roleItem, roleSetItem);

        // Create instance profile
        if (roleItem.instanceProfile) {
          this.logger.info(`Role - creating instance profile for ${roleItem.name}`);
          new cdk.aws_iam.CfnInstanceProfile(this, `${pascalCase(roleItem.name)}InstanceProfile`, {
            // Use role object to force use of Ref
            instanceProfileName: role.roleName,
            roles: [role.roleName],
          });
        }

        this.grantManagedActiveDirectorySecretAccess(roleItem.name, role);

        // Add to roles list
        this.roles[roleItem.name] = role;
      }
    }
  }

  /**
   * Function to grant managed active directory secret access to instance role if the role is used in managed ad instance
   * @param role
   */
  private grantManagedActiveDirectorySecretAccess(roleName: string, role: cdk.aws_iam.Role) {
    for (const managedActiveDirectory of this.props.iamConfig.managedActiveDirectories ?? []) {
      const madAccountId = this.props.accountsConfig.getAccountId(managedActiveDirectory.account);
      if (managedActiveDirectory.activeDirectoryConfigurationInstance) {
        if (
          managedActiveDirectory.activeDirectoryConfigurationInstance.instanceRole === roleName &&
          madAccountId === cdk.Stack.of(this).account &&
          managedActiveDirectory.region === cdk.Stack.of(this).region
        ) {
          const madAdminSecretAccountId = this.props.accountsConfig.getAccountId(
            this.props.iamConfig.getManageActiveDirectorySecretAccountName(managedActiveDirectory.name),
          );
          const madAdminSecretRegion = this.props.iamConfig.getManageActiveDirectorySecretRegion(
            managedActiveDirectory.name,
          );

          const secretArn = `arn:${
            cdk.Stack.of(this).partition
          }:secretsmanager:${madAdminSecretRegion}:${madAdminSecretAccountId}:secret:${
            this.props.prefixes.secretName
          }/ad-user/${managedActiveDirectory.name}/*`;
          // Attach MAD instance role access to MAD secrets
          this.logger.info(`Granting mad secret access to ${roleName}`);
          role.attachInlinePolicy(
            new cdk.aws_iam.Policy(
              this,
              `${pascalCase(managedActiveDirectory.name)}${pascalCase(roleName)}SecretsAccess`,
              {
                statements: [
                  new cdk.aws_iam.PolicyStatement({
                    effect: cdk.aws_iam.Effect.ALLOW,
                    actions: ['secretsmanager:GetSecretValue'],
                    resources: [secretArn],
                  }),
                ],
              },
            ),
          );

          // AwsSolutions-IAM5: The IAM entity contains wildcard permissions
          this.nagSuppressionInputs.push({
            id: NagSuppressionRuleIds.IAM5,
            details: [
              {
                path: `${this.stackName}/${pascalCase(managedActiveDirectory.name)}${pascalCase(
                  roleName,
                )}SecretsAccess/Resource`,
                reason: 'MAD instance role need access to more than one mad user secrets',
              },
            ],
          });
        }
      }
    }
  }

  /**
   *  Adds IAM Groups
   */
  private addGroups() {
    for (const groupSetItem of this.props.iamConfig.groupSets ?? []) {
      if (!this.isIncluded(groupSetItem.deploymentTargets)) {
        this.logger.info(`Item excluded`);
        continue;
      }

      for (const groupItem of groupSetItem.groups) {
        this.logger.info(`Add group ${groupItem.name}`);

        const managedPolicies: cdk.aws_iam.IManagedPolicy[] = [];
        for (const policyItem of groupItem.policies?.awsManaged ?? []) {
          this.logger.info(`Group - aws managed policy ${policyItem}`);
          managedPolicies.push(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(policyItem));
        }
        for (const policyItem of groupItem.policies?.customerManaged ?? []) {
          this.logger.info(`Group - customer managed policy ${policyItem}`);
          managedPolicies.push(this.policies[policyItem]);
        }

        this.groups[groupItem.name] = new cdk.aws_iam.Group(this, pascalCase(groupItem.name), {
          groupName: groupItem.name,
          managedPolicies,
        });

        // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
        // rule suppression with evidence for this permission.
        this.nagSuppressionInputs.push({
          id: NagSuppressionRuleIds.IAM4,
          details: [
            {
              path: `${this.stackName}/${pascalCase(groupItem.name)}/Resource`,
              reason: 'Groups created as per accelerator iam-config needs AWS managed policy',
            },
          ],
        });
      }
    }
  }

  /**
   * Adds IAM Users
   */
  private addUsers() {
    for (const userSet of this.props.iamConfig.userSets ?? []) {
      if (!this.isIncluded(userSet.deploymentTargets)) {
        this.logger.info(`Item excluded`);
        continue;
      }

      for (const user of userSet.users ?? []) {
        this.logger.info(`Add user ${user.username}`);

        const secret = new cdk.aws_secretsmanager.Secret(this, pascalCase(`${user.username}Secret`), {
          generateSecretString: {
            secretStringTemplate: JSON.stringify({ username: user.username }),
            generateStringKey: 'password',
          },
          secretName: `${this.props.prefixes.secretName}/${user.username}`,
        });

        // AwsSolutions-SMG4: The secret does not have automatic rotation scheduled.
        // rule suppression with evidence for this permission.
        this.nagSuppressionInputs.push({
          id: NagSuppressionRuleIds.SMG4,
          details: [
            {
              path: `${this.stackName}/${pascalCase(user.username)}Secret/Resource`,
              reason: 'Accelerator users created as per iam-config file, MFA usage is enforced with boundary policy',
            },
          ],
        });

        this.logger.info(`User - password stored to ${this.props.prefixes.secretName}/${user.username}`);

        this.users[user.username] = new cdk.aws_iam.User(this, pascalCase(user.username), {
          userName: user.username,
          password: secret.secretValueFromJson('password'),
          groups: [this.groups[user.group]],
          permissionsBoundary: this.policies[user.boundaryPolicy],
          passwordResetRequired: true,
        });
      }
    }
  }

  /**
   * Enables budget reports
   */
  private enableBudgetReports() {
    this.cloudwatchKey = cdk.aws_kms.Key.fromKeyArn(
      this,
      'AcceleratorBudgetGetCloudWatchKey',
      cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        this.acceleratorResourceNames.parameters.cloudWatchLogCmkArn,
      ),
    ) as cdk.aws_kms.Key;
    if (this.props.globalConfig.reports?.budgets) {
      for (const budget of this.props.globalConfig.reports.budgets ?? []) {
        if (this.isIncluded(budget.deploymentTargets ?? [])) {
          this.logger.info(`Add budget ${budget.name}`);
          new BudgetDefinition(this, `${budget.name}BudgetDefinition`, {
            kmsKey: this.cloudwatchKey,
            logRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
            amount: budget.amount,
            includeCredit: budget.includeCredit,
            includeDiscount: budget.includeDiscount,
            includeOtherSubscription: budget.includeOtherSubscription,
            includeRecurring: budget.includeRecurring,
            includeRefund: budget.includeRefund,
            includeSubscription: budget.includeSubscription,
            includeSupport: budget.includeSupport,
            includeTax: budget.includeTax,
            includeUpfront: budget.includeUpfront,
            name: budget.name,
            notifications: budget.notifications,
            timeUnit: budget.timeUnit,
            type: budget.type,
            useAmortized: budget.useAmortized,
            useBlended: budget.useBlended,
            unit: budget.unit,
          });
        }
      }
    }
  }

  /**
   * Adds Backup Vaults as defined in the global-config.yaml. These Vaults can
   * be referenced in AWS Organizations Backup Policies
   */
  private addBackupVaults() {
    let backupKey: cdk.aws_kms.Key | undefined = undefined;
    for (const vault of this.props.globalConfig.backup?.vaults ?? []) {
      if (this.isIncluded(vault.deploymentTargets)) {
        // Only create the key if a vault is defined for this account
        if (backupKey === undefined) {
          backupKey = new cdk.aws_kms.Key(this, 'BackupKey', {
            alias: this.acceleratorResourceNames.customerManagedKeys.awsBackup.alias,
            description: this.acceleratorResourceNames.customerManagedKeys.awsBackup.description,
            enableKeyRotation: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
          });
        }

        new cdk.aws_backup.BackupVault(this, `BackupVault_${vault.name}`, {
          backupVaultName: vault.name,
          encryptionKey: backupKey,
        });
      }
    }
  }

  private enableInventory() {
    this.logger.info('Enabling SSM Inventory');

    new Inventory(this, 'AcceleratorSsmInventory', {
      bucketName: `${
        this.acceleratorResourceNames.bucketPrefixes.centralLogs
      }-${this.props.accountsConfig.getLogArchiveAccountId()}-${this.props.centralizedLoggingRegion}`,
      bucketRegion: this.props.centralizedLoggingRegion,
      accountId: cdk.Stack.of(this).account,
      prefix: this.props.prefixes.bucketName,
    });
  }

  /**
   * Creates CloudFormation roles required for StackSets if stacksets are defined in customizations-config.yaml
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stacksets-prereqs-self-managed.html#prereqs-self-managed-permissions
   */
  private createStackSetRoles() {
    if (this.props.customizationsConfig?.customizations?.cloudFormationStackSets) {
      const managementAccountId = this.props.accountsConfig.getManagementAccountId();
      if (cdk.Stack.of(this).account == managementAccountId) {
        this.createStackSetAdminRole();
      }
      this.createStackSetExecutionRole(managementAccountId);
    }
  }

  private createStackSetAdminRole() {
    this.logger.info(`Creating StackSet Administrator Role`);
    new cdk.aws_iam.Role(this, 'StackSetAdminRole', {
      roleName: 'AWSCloudFormationStackSetAdministrationRole',
      assumedBy: new cdk.aws_iam.ServicePrincipal('cloudformation.amazonaws.com'),
      description: 'Assumes AWSCloudFormationStackSetExecutionRole in workload accounts to deploy StackSets',
      inlinePolicies: {
        AssumeRole: new cdk.aws_iam.PolicyDocument({
          statements: [
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: ['sts:AssumeRole'],
              resources: ['arn:*:iam::*:role/AWSCloudFormationStackSetExecutionRole'],
            }),
          ],
        }),
      },
    });
  }

  private createServiceCatalogPropagationRole() {
    new cdk.aws_iam.Role(this, 'ServiceCatalogPropagationRole', {
      roleName: this.acceleratorResourceNames.roles.crossAccountServiceCatalogPropagation,
      assumedBy: this.getOrgPrincipals(this.organizationId),
      inlinePolicies: {
        default: new cdk.aws_iam.PolicyDocument({
          statements: [
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: [
                'iam:GetGroup',
                'iam:GetRole',
                'iam:GetUser',
                'iam:ListRoles',
                'servicecatalog:AcceptPortfolioShare',
                'servicecatalog:AssociatePrincipalWithPortfolio',
                'servicecatalog:DisassociatePrincipalFromPortfolio',
                'servicecatalog:ListAcceptedPortfolioShares',
                'servicecatalog:ListPrincipalsForPortfolio',
              ],
              resources: ['*'],
              conditions: {
                ArnLike: {
                  'aws:PrincipalARN': [
                    `arn:${cdk.Stack.of(this).partition}:iam::*:role/${this.props.prefixes.accelerator}-*`,
                  ],
                },
              },
            }),
          ],
        }),
      },
    });

    // AwsSolutions-IAM5: The IAM entity contains wildcard permissions and does not have a cdk_nag rule suppression with evidence for those permission
    // rule suppression with evidence for this permission.
    this.nagSuppressionInputs.push({
      id: NagSuppressionRuleIds.IAM5,
      details: [
        {
          path: `${this.stackName}/ServiceCatalogPropagationRole/Resource`,
          reason: 'Policy must have access to all Service Catalog Portfolios and IAM Roles',
        },
      ],
    });
  }

  /**
   * Function to create Identity Center Permission Sets
   * @param identityCenterItem
   * @param identityCenterInstanceArn
   * @returns
   */
  private addIdentityCenterPermissionSets(
    identityCenterItem: IdentityCenterConfig,
    identityCenterInstanceArn: string,
  ): PermissionSetMapping[] {
    const permissionSetMap: PermissionSetMapping[] = [];

    for (const identityCenterPermissionSet of identityCenterItem.identityCenterPermissionSets ?? []) {
      const permissionSet = this.createPermissionsSet(
        identityCenterPermissionSet,
        identityCenterInstanceArn,
        permissionSetMap,
      );
      permissionSetMap.push(permissionSet);
    }

    return permissionSetMap;
  }

  /**
   * Function to get CustomerManaged Policy References List
   * @param identityCenterPermissionSet {@link IdentityCenterPermissionSetConfig}
   * @returns customerManagedPolicyReferencesList {@link cdk.aws_sso.CfnPermissionSet.CustomerManagedPolicyReferenceProperty}[]
   */
  private getCustomerManagedPolicyReferencesList(
    identityCenterPermissionSet: IdentityCenterPermissionSetConfig,
  ): cdk.aws_sso.CfnPermissionSet.CustomerManagedPolicyReferenceProperty[] {
    const customerManagedPolicyReferencesList: cdk.aws_sso.CfnPermissionSet.CustomerManagedPolicyReferenceProperty[] =
      [];

    if (identityCenterPermissionSet.policies) {
      this.logger.info(`Adding Identity Center Permission Set ${identityCenterPermissionSet.name}`);

      // Add Customer managed and LZA managed policies
      for (const policy of [
        ...(identityCenterPermissionSet.policies.customerManaged ?? []),
        ...(identityCenterPermissionSet.policies.acceleratorManaged ?? []),
      ]) {
        customerManagedPolicyReferencesList.push({ name: policy });
      }
    }

    return customerManagedPolicyReferencesList;
  }

  /**
   * Function to get AWS Managed permissionsets
   * @param identityCenterPermissionSet {@link IdentityCenterPermissionSetConfig}
   * @returns awsManagedPolicies string[]
   */
  private getAwsManagedPolicies(identityCenterPermissionSet: IdentityCenterPermissionSetConfig): string[] {
    const awsManagedPolicies: string[] = [];

    for (const awsManagedPolicy of identityCenterPermissionSet?.policies?.awsManaged ?? []) {
      if (awsManagedPolicy.startsWith('arn:')) {
        awsManagedPolicies.push(awsManagedPolicy);
      } else {
        awsManagedPolicies.push(cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(awsManagedPolicy).managedPolicyArn);
      }
    }

    return awsManagedPolicies;
  }

  /**
   * Function to get permission boundary
   * @param identityCenterPermissionSet {@link IdentityCenterPermissionSetConfig}
   * @returns permissionsBoundary {@link cdk.aws_sso.CfnPermissionSet.PermissionsBoundaryProperty} | undefined
   */
  private getPermissionBoundary(
    identityCenterPermissionSet: IdentityCenterPermissionSetConfig,
  ): cdk.aws_sso.CfnPermissionSet.PermissionsBoundaryProperty | undefined {
    let permissionsBoundary: cdk.aws_sso.CfnPermissionSet.PermissionsBoundaryProperty | undefined;

    if (identityCenterPermissionSet.policies?.permissionsBoundary) {
      if (identityCenterPermissionSet.policies.permissionsBoundary.customerManagedPolicy) {
        permissionsBoundary = {
          customerManagedPolicyReference: {
            name: identityCenterPermissionSet.policies.permissionsBoundary.customerManagedPolicy.name,
            path: identityCenterPermissionSet.policies.permissionsBoundary.customerManagedPolicy.path,
          },
        };
      }
      if (identityCenterPermissionSet.policies.permissionsBoundary.awsManagedPolicyName) {
        permissionsBoundary = {
          managedPolicyArn: cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
            identityCenterPermissionSet.policies.permissionsBoundary.awsManagedPolicyName,
          ).managedPolicyArn,
        };
      }
    }

    return permissionsBoundary;
  }

  /**
   * Create Identity Center Permission sets
   * @param identityCenterPermissionSet
   * @param identityCenterInstanceArn
   * @returns
   */
  private createPermissionsSet(
    identityCenterPermissionSet: IdentityCenterPermissionSetConfig,
    identityCenterInstanceArn: string,
    permissionSetMap: PermissionSetMapping[],
  ): PermissionSetMapping {
    const customerManagedPolicyReferencesList =
      this.getCustomerManagedPolicyReferencesList(identityCenterPermissionSet);

    let convertedSessionDuration: string | undefined;

    if (identityCenterPermissionSet.sessionDuration) {
      convertedSessionDuration = this.convertMinutesToIso8601(identityCenterPermissionSet.sessionDuration);
    }

    const awsManagedPolicies = this.getAwsManagedPolicies(identityCenterPermissionSet);

    const permissionsBoundary = this.getPermissionBoundary(identityCenterPermissionSet);

    let permissionSetProps: cdk.aws_sso.CfnPermissionSetProps = {
      name: identityCenterPermissionSet.name,
      instanceArn: identityCenterInstanceArn,
      managedPolicies: awsManagedPolicies.length > 0 ? awsManagedPolicies : undefined,
      customerManagedPolicyReferences:
        customerManagedPolicyReferencesList.length > 0 ? customerManagedPolicyReferencesList : undefined,
      sessionDuration: convertedSessionDuration,
      permissionsBoundary: permissionsBoundary,
    };

    if (identityCenterPermissionSet.policies?.inlinePolicy) {
      // Read in the policy document which should be properly formatted json
      const inlinePolicyDocument = JSON.parse(
        this.generatePolicyReplacements(
          path.join(this.props.configDirPath, identityCenterPermissionSet.policies?.inlinePolicy),
          false,
        ),
      );
      permissionSetProps = {
        name: identityCenterPermissionSet.name,
        instanceArn: identityCenterInstanceArn,
        managedPolicies: awsManagedPolicies.length > 0 ? awsManagedPolicies : undefined,
        customerManagedPolicyReferences:
          customerManagedPolicyReferencesList.length > 0 ? customerManagedPolicyReferencesList : undefined,
        sessionDuration: convertedSessionDuration ?? undefined,
        inlinePolicy: inlinePolicyDocument,
        permissionsBoundary: permissionsBoundary,
      };
    }

    const permissionSet = new cdk.aws_sso.CfnPermissionSet(
      this,
      `${pascalCase(identityCenterPermissionSet.name)}IdentityCenterPermissionSet`,
      permissionSetProps,
    );

    // Create dependency for CfnPermissionSet
    for (const item of permissionSetMap) {
      permissionSet.node.addDependency(item.permissionSet);
    }

    return { name: permissionSet.name, arn: permissionSet.attrPermissionSetArn, permissionSet: permissionSet };
  }

  private addIdentityCenterAssignments(
    identityCenterItem: IdentityCenterConfig,
    identityCenterInstanceArn: string,
    permissionSetMap: PermissionSetMapping[],
  ) {
    for (const assignment of identityCenterItem.identityCenterAssignments ?? []) {
      this.createAssignment(assignment, permissionSetMap, identityCenterInstanceArn);
    }
  }

  private getAssignmentPrincipals(
    assignment: IdentityCenterAssignmentConfig,
    targetAccountId: string,
  ): { type: string; name: string; id: string }[] {
    if (!assignment.principals || assignment.principals.length === 0) {
      return [];
    }

    const identityStoreId = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      this.acceleratorResourceNames.parameters.identityStoreId,
    );

    const usersGroupsMetadata = new UsersGroupsMetadata(
      this,
      pascalCase(`UsersGroupsMetadata-${assignment.name}-${targetAccountId}`),
      {
        globalRegion: this.props.globalRegion,
        identityStoreId: identityStoreId,
        principals: assignment.principals,
        resourceUniqueIdentifier: `${targetAccountId}-${assignment.name}`,
        customResourceLambdaEnvironmentEncryptionKmsKey: cdk.aws_kms.Key.fromKeyArn(
          this,
          'AcceleratorGetLambdaKey',
          cdk.aws_ssm.StringParameter.valueForStringParameter(
            this,
            this.acceleratorResourceNames.parameters.lambdaCmkArn,
          ),
        ),
        customResourceLambdaCloudWatchLogKmsKey: this.cloudwatchKey,
        customResourceLambdaLogRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
      },
    );

    return usersGroupsMetadata.principalsMetadata;
  }

  private createAssignment(
    assignment: IdentityCenterAssignmentConfig,
    permissionSetMap: PermissionSetMapping[],
    identityCenterInstanceArn: string,
  ) {
    const targetAccountIds = this.getAccountIdsFromDeploymentTarget(assignment.deploymentTargets);
    const permissionSetArnValue = this.getPermissionSetArn(permissionSetMap, assignment.permissionSetName);

    for (const targetAccountId of targetAccountIds) {
      // backward compatibility for principalId & principalType property
      if (assignment.principalId && assignment.principalType) {
        this.logger.info(`Creating Identity Center Assignment ${assignment.name}-${targetAccountId}`);
        new cdk.aws_sso.CfnAssignment(this, `${pascalCase(assignment.name)}-${targetAccountId}`, {
          instanceArn: identityCenterInstanceArn,
          permissionSetArn: permissionSetArnValue,
          principalId: assignment.principalId,
          principalType: assignment.principalType,
          targetId: targetAccountId,
          targetType: 'AWS_ACCOUNT',
        });
      }

      // New feature with list of principals in assignment
      const cfnAssignments: cdk.aws_sso.CfnAssignment[] = [];

      const assignmentPrincipals = this.getAssignmentPrincipals(assignment, targetAccountId);

      for (const assignmentPrincipal of assignmentPrincipals) {
        const cfnAssignment = new cdk.aws_sso.CfnAssignment(
          this,
          `${pascalCase(assignment.name)}-${targetAccountId}-${assignmentPrincipal.type}-${assignmentPrincipal.name}`,
          {
            instanceArn: identityCenterInstanceArn,
            permissionSetArn: permissionSetArnValue,
            principalId: assignmentPrincipal.id,
            principalType: assignmentPrincipal.type,
            targetId: targetAccountId,
            targetType: 'AWS_ACCOUNT',
          },
        );

        // To create dependency for CfnAssignment object
        for (const dependency of cfnAssignments) {
          cfnAssignment.addDependency(dependency);
        }
        cfnAssignments.push(cfnAssignment);
      }
    }
  }

  private getPermissionSetArn(permissionSetMap: PermissionSetMapping[], name: string) {
    let permissionSetArn = '';
    for (const permissionSet of permissionSetMap) {
      if (permissionSet.name == name && permissionSet.arn) {
        permissionSetArn = permissionSet.arn;
      }
    }
    return permissionSetArn;
  }

  /**
   * Function to add Identity Center Resources
   * @param securityAdminAccountId
   */
  private addIdentityCenterResources(securityAdminAccountId: string) {
    if (this.props.iamConfig.identityCenter) {
      const delegatedAdminAccountId = this.props.iamConfig.identityCenter.delegatedAdminAccount
        ? this.props.accountsConfig.getAccountId(this.props.iamConfig.identityCenter.delegatedAdminAccount)
        : securityAdminAccountId;

      if (cdk.Stack.of(this).account === delegatedAdminAccountId) {
        const identityCenterInstanceArn = cdk.aws_ssm.StringParameter.valueForStringParameter(
          this,
          this.acceleratorResourceNames.parameters.identityCenterInstanceArn,
        );

        const permissionSetList = this.addIdentityCenterPermissionSets(
          this.props.iamConfig.identityCenter,
          identityCenterInstanceArn,
        );

        this.addIdentityCenterAssignments(
          this.props.iamConfig.identityCenter,
          identityCenterInstanceArn,
          permissionSetList,
        );
      }
    }
  }

  private createStackSetExecutionRole(managementAccountId: string) {
    this.logger.info(`Creating StackSet Execution Role`);
    new cdk.aws_iam.Role(this, 'StackSetExecutionRole', {
      roleName: 'AWSCloudFormationStackSetExecutionRole',
      assumedBy: new cdk.aws_iam.AccountPrincipal(managementAccountId),
      description: 'Used to deploy StackSets',
      managedPolicies: [cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')],
    });

    // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
    // rule suppression with evidence for this permission.
    this.nagSuppressionInputs.push({
      id: NagSuppressionRuleIds.IAM4,
      details: [
        {
          path: `${this.stackName}/StackSetExecutionRole/Resource`,
          reason: 'IAM Role created as per accelerator iam-config needs AWS managed policy',
        },
      ],
    });

    // AwsSolutions-IAM5: The IAM entity contains wildcard permissions and does not have a cdk_nag rule suppression with evidence for those permission
    // rule suppression with evidence for this permission.
    this.nagSuppressionInputs.push({
      id: NagSuppressionRuleIds.IAM5,
      details: [
        {
          path: `${this.stackName}/StackSetAdminRole/Resource`,
          reason: 'Policies definition are derived from accelerator iam-config boundary-policy file',
        },
      ],
    });
  }

  private createAssetAccessRole() {
    const accessBucketArn = `arn:${this.props.partition}:s3:::${
      this.acceleratorResourceNames.bucketPrefixes.assets
    }-${this.props.accountsConfig.getManagementAccountId()}-${this.props.globalConfig.homeRegion}`;

    const accountId = cdk.Stack.of(this).account;

    const accessRoleResourceName = `AssetAccessRole${accountId}`;
    const assetsAccessRole = new cdk.aws_iam.Role(this, accessRoleResourceName, {
      roleName: `${this.props.prefixes.accelerator}-AssetsAccessRole`,
      assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'AWS Accelerator assets access role in workload accounts deploy ACM imported certificates.',
    });
    assetsAccessRole.addManagedPolicy(
      cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );
    assetsAccessRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        resources: [`${accessBucketArn}`, `${accessBucketArn}/*`],
        actions: ['s3:GetObject*', 's3:ListBucket'],
      }),
    );
    assetsAccessRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        resources: [`arn:${this.props.partition}:acm:*:${accountId}:certificate/*`],
        actions: ['acm:ImportCertificate'],
      }),
    );
    assetsAccessRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        resources: ['*'],
        actions: ['acm:RequestCertificate', 'acm:DeleteCertificate'],
      }),
    );
    assetsAccessRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        resources: [`arn:${this.props.partition}:ssm:*:${accountId}:parameter/*`],
        actions: ['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:GetParameter'],
      }),
    );

    const assetsBucketKmsKey = new KeyLookup(this, 'AssetsBucketKms', {
      accountId: this.props.accountsConfig.getManagementAccountId(),
      keyRegion: this.props.globalConfig.homeRegion,
      roleName: this.acceleratorResourceNames.roles.crossAccountAssetsBucketCmkArnSsmParameterAccess,
      keyArnParameterName: this.acceleratorResourceNames.parameters.assetsBucketCmkArn,
      kmsKey: this.cloudwatchKey,
      logRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
      acceleratorPrefix: this.props.prefixes.accelerator,
    }).getKey();

    assetsAccessRole.addToPolicy(
      new cdk.aws_iam.PolicyStatement({
        resources: [assetsBucketKmsKey.keyArn],
        actions: ['kms:Decrypt'],
      }),
    );

    // AwsSolutions-IAM5: The IAM entity contains wildcard permissions and does not have a cdk_nag rule suppression with evidence for those permission
    // rule suppression with evidence for this permission.
    this.nagSuppressionInputs.push({
      id: NagSuppressionRuleIds.IAM5,
      details: [
        {
          path: `${this.stackName}/${accessRoleResourceName}/DefaultPolicy/Resource`,
          reason: 'Policy permissions are part of managed role and rest is to get access from s3 bucket',
        },
      ],
    });

    // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
    // rule suppression with evidence for this permission.
    this.nagSuppressionInputs.push({
      id: NagSuppressionRuleIds.IAM4,
      details: [
        {
          path: `${this.stackName}/${accessRoleResourceName}/Resource`,
          reason: 'IAM Role for lambda needs AWS managed policy',
        },
      ],
    });
  }

  private warmAccount(warm: boolean) {
    if (!warm) {
      return;
    }
    new WarmAccount(this, 'WarmAccount', {
      cloudwatchKmsKey: this.cloudwatchKey,
      logRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
      ssmPrefix: this.props.prefixes.ssmParamName,
    });
  }
}
