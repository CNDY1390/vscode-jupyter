// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { assert } from 'chai';
import * as fs from 'fs-extra';
import * as path from '../../../../platform/vscode-path/path';
import * as sinon from 'sinon';
import { commands, Memento, workspace, window, Uri, NotebookCell, NotebookCellKind } from 'vscode';
import { IPythonApiProvider } from '../../../../platform/api/types';
import { Kernel } from '../../../../kernels/kernel';
import { getDisplayPath } from '../../../../platform/common/platform/fs-paths';
import {
    GLOBAL_MEMENTO,
    IConfigurationService,
    IDisposable,
    IMemento,
    IWatchableJupyterSettings,
    ReadWrite
} from '../../../../platform/common/types';
import { createDeferred, sleep } from '../../../../platform/common/utils/async';
import { Common, DataScience } from '../../../../platform/common/utils/localize';
import { IInterpreterService } from '../../../../platform/interpreter/contracts';
import { areInterpreterPathsSame } from '../../../../platform/pythonEnvironments/info/interpreter';
import { captureScreenShot, IExtensionTestApi, waitForCondition } from '../../../common.node';
import {
    EXTENSION_ROOT_DIR_FOR_TESTS,
    IS_REMOTE_NATIVE_TEST,
    JVSC_EXTENSION_ID_FOR_TESTS
} from '../../../constants.node';
import { closeActiveWindows, initialize } from '../../../initialize.node';
import {
    installIPyKernel,
    openNotebook,
    submitFromPythonFileUsingCodeWatcher,
    uninstallIPyKernel
} from '../../helpers.node';
import { WrappedError } from '../../../../platform/errors/types';
import { clearInstalledIntoInterpreterMemento } from '../../../../platform/interpreter/installer/productInstaller';
import { ProductNames } from '../../../../platform/interpreter/installer/productNames';
import { Product, IInstaller, InstallerResponse } from '../../../../platform/interpreter/installer/types';
import {
    closeNotebooksAndCleanUpAfterTests,
    hijackPrompt,
    runAllCellsInActiveNotebook,
    assertVSCCellIsNotRunning,
    defaultNotebookTestTimeout,
    waitForKernelToChange,
    waitForExecutionCompletedSuccessfully,
    getCellOutputs,
    waitForCellHavingOutput,
    insertCodeCell,
    WindowPromptStub,
    waitForTextOutput,
    createTemporaryNotebookFromFile
} from '../../notebook/helper.node';
import * as kernelSelector from '../../../../notebooks/controllers/kernelSelector';
import { Commands, JupyterNotebookView } from '../../../../platform/common/constants';
import { getDisplayPathFromLocalFile } from '../../../../platform/common/platform/fs-paths.node';
import { getOSType, OSType } from '../../../../platform/common/utils/platform';
import { isUri } from '../../../../platform/common/utils/misc';
import { hasErrorOutput, translateCellErrorOutput } from '../../../../kernels/execution/helpers';
import { BaseKernelError } from '../../../../kernels/errors/types';
import { IControllerRegistration } from '../../../../notebooks/controllers/types';
import type { PythonEnvironment } from '../../../../api';

/* eslint-disable no-invalid-this, @typescript-eslint/no-explicit-any */
suite('Install IPyKernel (install) @kernelCore', function () {
    const disposables: IDisposable[] = [];
    let nbFile: Uri;
    const templateIPynbFile = Uri.file(
        path.join(EXTENSION_ROOT_DIR_FOR_TESTS, 'src/test/datascience/jupyter/kernels/nbWithKernel.ipynb')
    );
    const executable = getOSType() === OSType.Windows ? 'Scripts/python.exe' : 'bin/python'; // If running locally on Windows box.
    let venvNoKernelPath = Uri.file(
        path.join(EXTENSION_ROOT_DIR_FOR_TESTS, 'src/test/datascience/.venvnokernel', executable)
    );
    let venvNoRegPath = Uri.file(
        path.join(EXTENSION_ROOT_DIR_FOR_TESTS, 'src/test/datascience/.venvnoreg', executable)
    );
    let venvKernelPath = Uri.file(
        path.join(EXTENSION_ROOT_DIR_FOR_TESTS, 'src/test/datascience/.venvkernel', executable)
    );
    const expectedPromptMessageSuffix = `requires the ${ProductNames.get(Product.ipykernel)!} package`;

    let api: IExtensionTestApi;
    let installer: IInstaller;
    let memento: Memento;
    let installerSpy: sinon.SinonSpy;
    let controllerRegistration: IControllerRegistration;
    const delayForUITest = 120_000;
    this.timeout(120_000); // Slow test, we need to uninstall/install ipykernel.
    let configSettings: ReadWrite<IWatchableJupyterSettings>;
    let previousDisableJupyterAutoStartValue: boolean;
    let venvNoKernelPathEnv: PythonEnvironment | undefined;
    let venvNoRegPathEnv: PythonEnvironment | undefined;
    let venvKernelPathEnv: PythonEnvironment | undefined;
    /*
    This test requires a virtual environment to be created & registered as a kernel.
    It also needs to have ipykernel installed in it.
    */
    suiteSetup(async function () {
        // These are slow tests, hence lets run only on linux on CI.
        if (IS_REMOTE_NATIVE_TEST()) {
            return this.skip();
        }
        if (!fs.pathExistsSync(venvNoKernelPath.fsPath) || !fs.pathExistsSync(venvNoRegPath.fsPath)) {
            // Virtual env does not exist.
            return this.skip();
        }
        this.timeout(120_000);
        api = await initialize();
        installer = api.serviceContainer.get<IInstaller>(IInstaller);
        memento = api.serviceContainer.get<Memento>(IMemento, GLOBAL_MEMENTO);
        controllerRegistration = api.serviceContainer.get<IControllerRegistration>(IControllerRegistration);
        const configService = api.serviceContainer.get<IConfigurationService>(IConfigurationService);
        configSettings = configService.getSettings(undefined) as any;
        previousDisableJupyterAutoStartValue = configSettings.disableJupyterAutoStart;
        configSettings.disableJupyterAutoStart = true;
        const pythonApi = await api.serviceManager.get<IPythonApiProvider>(IPythonApiProvider).getNewApi();
        await pythonApi?.environments.refreshEnvironments({ forceRefresh: true });
        const interpreterService = api.serviceContainer.get<IInterpreterService>(IInterpreterService);
        let lastError: Error | undefined = undefined;
        [venvNoKernelPathEnv, venvNoRegPathEnv, venvKernelPathEnv] = await waitForCondition(
            async () => {
                try {
                    return await Promise.all([
                        interpreterService.getInterpreterDetails(venvNoKernelPath),
                        interpreterService.getInterpreterDetails(venvNoRegPath),
                        interpreterService.getInterpreterDetails(venvKernelPath)
                    ]);
                } catch (ex) {
                    lastError = ex;
                }
            },
            defaultNotebookTestTimeout,
            () => `Failed to get interpreter information for 1,2 &/or 3, ${lastError?.toString()}`
        );
        if (!venvKernelPathEnv || !venvNoKernelPathEnv || !venvNoRegPathEnv) {
            throw new Error('Unable to get information for interpreter 1,2,3');
        }
        venvNoKernelPath = venvNoKernelPathEnv.uri;
        venvNoRegPath = venvNoRegPathEnv.uri;
        venvKernelPath = venvKernelPathEnv.uri;
    });
    setup(async function () {
        console.log(`Start test ${this.currentTest?.title}`);
        const configService = api.serviceContainer.get<IConfigurationService>(IConfigurationService);
        configSettings = configService.getSettings(undefined) as any;
        configSettings.disableJupyterAutoStart = true;
        const pythonApi = await api.serviceManager.get<IPythonApiProvider>(IPythonApiProvider).getNewApi();
        const env = await pythonApi?.environments.resolveEnvironment(venvNoKernelPath.fsPath);
        // Don't use same file (due to dirty handling, we might save in dirty.)
        // Coz we won't save to file, hence extension will backup in dirty file and when u re-open it will open from dirty.
        nbFile = await createTemporaryNotebookFromFile(templateIPynbFile, disposables);
        // Update hash in notebook metadata.
        const id = Uri.parse(env!.id).toString();
        fs.writeFileSync(nbFile.fsPath, fs.readFileSync(nbFile.fsPath).toString('utf8').replace('<id>', id));
        await Promise.all([
            installIPyKernel(venvKernelPath.fsPath),
            uninstallIPyKernel(venvNoKernelPath.fsPath),
            uninstallIPyKernel(venvNoRegPath.fsPath)
        ]);
        await closeActiveWindows();
        await Promise.all([
            clearInstalledIntoInterpreterMemento(memento, Product.ipykernel, venvNoKernelPathEnv!),
            clearInstalledIntoInterpreterMemento(memento, Product.ipykernel, venvNoRegPathEnv!)
        ]);
        sinon.restore();
        console.log(`Start Test completed ${this.currentTest?.title}`);
    });
    teardown(async function () {
        console.log(`End test ${this.currentTest?.title}`);
        if (this.currentTest?.isFailed()) {
            await captureScreenShot(this);
        }
        configSettings.disableJupyterAutoStart = previousDisableJupyterAutoStartValue;
        await closeNotebooksAndCleanUpAfterTests(disposables);
        sinon.restore();
    });
    suiteTeardown(async function () {
        // Make sure to put ipykernel back
        try {
            await installIPyKernel(venvNoKernelPath.fsPath);
            await uninstallIPyKernel(venvNoRegPath.fsPath);
        } catch (ex) {
            // Don't fail test
        }
    });

    test('Test Install IPyKernel prompt message', async () => {
        // Confirm the message has not changed.
        assert.ok(
            DataScience.libraryRequiredToLaunchJupyterKernelNotInstalledInterpreter(
                '',
                ProductNames.get(Product.ipykernel)!
            ).endsWith(`${expectedPromptMessageSuffix}.`),
            'Message has changed, please update this test'
        );
    });

    test(`Ensure prompt is displayed when ipykernel module is not found and it gets installed for '${path.basename(
        venvNoKernelPath.fsPath
    )}'`, async () => openNotebookAndInstallIpyKernelWhenRunningCell(venvNoKernelPath));
    test(`Ensure prompt is displayed when ipykernel module is not found and it gets installed for '${path.basename(
        venvNoRegPath.fsPath
    )}'`, async () => openNotebookAndInstallIpyKernelWhenRunningCell(venvNoKernelPath));
    test('Ensure ipykernel install prompt is displayed every time you try to run a cell in a Notebook', async function () {
        if (IS_REMOTE_NATIVE_TEST()) {
            return this.skip();
        }

        // Confirm message is displayed & then dismiss the message (so that execution stops due to missing dependency).
        const prompt = await hijackPrompt(
            'showInformationMessage',
            { contains: expectedPromptMessageSuffix },
            { dismissPrompt: true },
            disposables
        );

        const { notebook, editor } = await openNotebook(nbFile);
        await waitForKernelToChange({ interpreterPath: venvNoKernelPath }, editor);
        const cell = notebook.cellAt(0)!;
        assert.equal(cell.outputs.length, 0);

        // The prompt should be displayed when we run a cell.
        await runAllCellsInActiveNotebook(true, editor);
        await waitForCondition(async () => prompt.displayed.then(() => true), delayForUITest, 'Prompt not displayed');

        // Once ipykernel prompt has been dismissed, execution should stop due to missing dependencies.
        await waitForCondition(
            async () =>
                hasErrorOutput(cell.outputs) &&
                assertVSCCellIsNotRunning(cell) &&
                verifyInstallIPyKernelInstructionsInOutput(cell),
            defaultNotebookTestTimeout,
            'No errors in cell (first time)'
        );

        // Execute notebook once again & we should get another prompted to install ipykernel.
        let previousPromptDisplayCount = prompt.getDisplayCount();
        await runAllCellsInActiveNotebook(true, editor);
        await waitForCondition(
            async () => prompt.getDisplayCount() > previousPromptDisplayCount,
            delayForUITest,
            'Prompt not displayed second time'
        );

        // Once ipykernel prompt has been dismissed, execution should stop due to missing dependencies.
        await waitForCondition(
            async () => hasErrorOutput(cell.outputs) && assertVSCCellIsNotRunning(cell),
            defaultNotebookTestTimeout,
            'No errors in cell (second time)'
        );

        // Execute a cell this time & we should get yet another prompted to install ipykernel.
        previousPromptDisplayCount = prompt.getDisplayCount();
        await runAllCellsInActiveNotebook(true, editor);
        await waitForCondition(
            async () => prompt.getDisplayCount() > previousPromptDisplayCount,
            delayForUITest,
            'Prompt not displayed second time'
        );

        // Once ipykernel prompt has been dismissed, execution should stop due to missing dependencies.
        await waitForCondition(
            async () => hasErrorOutput(cell.outputs) && assertVSCCellIsNotRunning(cell),
            defaultNotebookTestTimeout,
            'No errors in cell (third time)'
        );
    });
    test('Get a single prompt when running all cells in a .py file without ipykernel and will run all cells upon installation', async () => {
        // Confirm message is displayed & then dismiss the message (so that execution stops due to missing dependency).
        let prompt = await hijackPrompt(
            'showInformationMessage',
            { contains: expectedPromptMessageSuffix },
            {},
            disposables
        );

        const source = '# %%\nprint(1)\n# %%\nprint(2)\n# %%\nprint(3)';
        const { activeInteractiveWindow } = await submitFromPythonFileUsingCodeWatcher(
            source,
            disposables,
            venvNoKernelPath
        );
        const notebookDocument = workspace.notebookDocuments.find(
            (doc) => doc.uri.toString() === activeInteractiveWindow?.notebookUri?.toString()
        )!;

        await verifyIPyKernelPromptDisplayed(prompt, venvNoKernelPath.fsPath);
        await sleep(500);
        await verifyIPyKernelPromptDisplayed(prompt, venvNoKernelPath.fsPath);
        await sleep(500);
        await verifyIPyKernelPromptDisplayed(prompt, venvNoKernelPath.fsPath);

        // Now lets install, all cells should run successfully.
        prompt.clickButton(Common.install);

        // Wait for the 3 cells to run successfully.
        const [cell1, cell2, cell3] = notebookDocument!
            .getCells()
            .filter((cell) => cell.kind === NotebookCellKind.Code);
        await Promise.all([
            waitForExecutionCompletedSuccessfully(cell1),
            waitForExecutionCompletedSuccessfully(cell2),
            waitForExecutionCompletedSuccessfully(cell3),
            waitForTextOutput(cell1, '1', 0, false),
            waitForTextOutput(cell2, '2', 0, false),
            waitForTextOutput(cell3, '3', 0, false)
        ]);
    });

    test('Ensure ipykernel install prompt is displayed even after uninstalling ipykernel (VSCode Notebook)', async function () {
        if (IS_REMOTE_NATIVE_TEST()) {
            return this.skip();
        }

        // Verify we can open a notebook, run a cell and ipykernel prompt should be displayed.
        await openNotebookAndInstallIpyKernelWhenRunningCell(venvNoKernelPath);
        await closeNotebooksAndCleanUpAfterTests();

        // Un-install IpyKernel
        await uninstallIPyKernel(venvNoKernelPath.fsPath);

        nbFile = await createTemporaryNotebookFromFile(templateIPynbFile, disposables);
        await openNotebookAndInstallIpyKernelWhenRunningCell(venvNoKernelPath);
    });
    test('Ensure ipykernel install prompt is displayed even selecting another kernel which too does not have IPyKernel installed (VSCode Notebook)', async function () {
        if (IS_REMOTE_NATIVE_TEST()) {
            return this.skip();
        }

        // Verify we can open a notebook, run a cell and ipykernel prompt should be displayed.
        await openNotebookAndInstallIpyKernelWhenRunningCell(venvNoKernelPath);
        await closeNotebooksAndCleanUpAfterTests();

        // Un-install IpyKernel
        await uninstallIPyKernel(venvNoKernelPath.fsPath);
        await uninstallIPyKernel(venvNoRegPath.fsPath);

        nbFile = await createTemporaryNotebookFromFile(templateIPynbFile, disposables);
        await openNotebookAndInstallIpyKernelWhenRunningCell(venvNoKernelPath, venvNoRegPath);
    });
    test('Ensure ipykernel install prompt is not displayed after selecting another kernel which has IPyKernel installed (VSCode Notebook)', async function () {
        if (IS_REMOTE_NATIVE_TEST()) {
            return this.skip();
        }

        // Verify we can open a notebook, run a cell and ipykernel prompt should be displayed.
        await openNotebookAndInstallIpyKernelWhenRunningCell(venvNoKernelPath);
        await closeNotebooksAndCleanUpAfterTests();

        // Un-install IpyKernel
        await uninstallIPyKernel(venvNoKernelPath.fsPath);
        await installIPyKernel(venvNoRegPath.fsPath);

        nbFile = await createTemporaryNotebookFromFile(templateIPynbFile, disposables);
        await openNotebookAndInstallIpyKernelWhenRunningCell(venvNoKernelPath, venvNoRegPath, 'DoNotInstallIPyKernel');
    });
    test('Ensure ipykernel install prompt is displayed and we can select another kernel after uninstalling IPyKernel from a live notebook and then restarting the kernel (VSCode Notebook)', async function () {
        if (IS_REMOTE_NATIVE_TEST()) {
            return this.skip();
        }
        // Verify we can open a notebook, run a cell and ipykernel prompt should be displayed.
        await openNotebookAndInstallIpyKernelWhenRunningCell(venvNoKernelPath);

        // Un-install IpyKernel
        await uninstallIPyKernel(venvNoKernelPath.fsPath);

        // Now that IPyKernel is missing, if we attempt to restart a kernel, we should get a prompt.
        // Previously things just hang at weird spots, its not a likely scenario, but this test ensures the code works as expected.
        const startController = controllerRegistration.getSelected(window.activeNotebookEditor?.notebook!);
        assert.ok(startController);

        // Confirm message is displayed.
        const promptToInstall = await selectKernelFromIPyKernelPrompt();
        const { kernelSelected } = hookupKernelSelected(promptToInstall, venvNoRegPath);

        await Promise.all([
            commands.executeCommand(Commands.RestartKernel, {
                notebookEditor: { notebookUri: nbFile }
            }),
            waitForCondition(
                async () => promptToInstall.displayed.then(() => true),
                delayForUITest,
                'Prompt not displayed'
            ),
            waitForCondition(async () => kernelSelected, delayForUITest, 'New kernel not selected'),
            // Verify the new kernel associated with this notebook is different.
            waitForCondition(
                async () => {
                    const newController = controllerRegistration.getSelected(window.activeNotebookEditor?.notebook!);
                    assert.ok(newController);
                    assert.notEqual(startController?.id, newController!.id);
                    return true;
                },
                delayForUITest,
                'Underlying IKernel should have changed as well'
            )
        ]);
    });
    test('Ensure ipykernel install prompt will switch', async function () {
        if (IS_REMOTE_NATIVE_TEST()) {
            return this.skip();
        }
        // Confirm message is displayed & then dismiss the message (so that execution stops due to missing dependency).
        const prompt = await hijackPrompt(
            'showInformationMessage',
            { contains: expectedPromptMessageSuffix },
            { result: DataScience.selectKernel, clickImmediately: true },
            disposables
        );

        const { editor } = await openNotebook(nbFile);

        // Hijack the select kernel functionality so it selects the correct kernel
        const stub = sinon.stub(kernelSelector, 'selectKernel').callsFake(async function () {
            await waitForKernelToChange({ interpreterPath: venvKernelPath }, editor);
            return true;
        } as any);
        const disposable = { dispose: () => stub.restore() };
        if (disposables) {
            disposables.push(disposable);
        }

        await waitForKernelToChange({ interpreterPath: venvNoKernelPath }, editor);
        const cell = editor.notebook.cellAt(0)!;
        assert.equal(cell.outputs.length, 0);

        // Insert another cell so we can test run all
        const cell2 = await insertCodeCell('print("foo")');

        // The prompt should be displayed when we run a cell.
        const runPromise = runAllCellsInActiveNotebook(false, editor);
        await waitForCondition(async () => prompt.displayed.then(() => true), 10_000, 'Prompt not displayed');

        // Now the run should finish
        await runPromise;
        await Promise.all([waitForExecutionCompletedSuccessfully(cell), waitForExecutionCompletedSuccessfully(cell2)]);
    });

    test('Ensure ipykernel install prompt is NOT displayed when auto start is enabled & ipykernel is missing (VSCode Notebook)', async function () {
        // Ensure we have auto start enabled, and verify kernel startup fails silently without any notifications.
        // When running a cell we should get an install prompt.
        configSettings.disableJupyterAutoStart = false;
        const promptToInstall = await clickInstallFromIPyKernelPrompt();
        const kernelStartSpy = sinon.spy(Kernel.prototype, 'start');
        await uninstallIPyKernel(venvNoKernelPath.fsPath);
        const { editor } = await openNotebook(nbFile);
        await waitForKernelToChange({ interpreterPath: venvNoKernelPath }, editor);
        await waitForCondition(
            async () => kernelStartSpy.callCount > 0,
            delayForUITest,
            'Did not attempt to auto start the kernel'
        );
        // Wait for kernel startup to fail & verify the error.
        try {
            await kernelStartSpy.getCall(0).returnValue;
            assert.fail('Did not fail as expected');
        } catch (ex) {
            const err = WrappedError.unwrap(ex) as BaseKernelError;
            // Depending on whether its jupter or raw kernels, we could get a different error thrown.
            assert.include('noipykernel kerneldied', err.category);
        }

        assert.strictEqual(promptToInstall.getDisplayCount(), 0, 'Prompt should not have been displayed');
        promptToInstall.dispose();

        assert.strictEqual(
            window.activeNotebookEditor?.notebook.cellAt(0).outputs.length,
            0,
            'Should not have any outputs with ipykernel missing error'
        );

        // If we try to run a cell, verify a prompt is displayed.
        await openNotebookAndInstallIpyKernelWhenRunningCell(venvNoKernelPath);
    });

    async function verifyIPyKernelPromptDisplayed(prompt: WindowPromptStub, venvPath: string) {
        // The prompt should be displayed when we run a cell.
        await waitForCondition(async () => prompt.displayed.then(() => true), delayForUITest, 'Prompt not displayed');

        assert.equal(prompt.getDisplayCount(), 1, 'Display prompt shown more than once');

        // Verify the the name of the env is displayed in the prompt.
        // This ensures we display the prompt for the right environment.
        const venvName = path.basename(path.dirname(path.dirname(venvPath)));
        assert.include(prompt.messages.join(' '), venvName);
    }

    async function selectKernelFromIPyKernelPrompt() {
        return hijackPrompt(
            'showInformationMessage',
            { contains: expectedPromptMessageSuffix },
            { result: DataScience.selectKernel, clickImmediately: true },
            disposables
        );
    }
    async function clickInstallFromIPyKernelPrompt() {
        return hijackPrompt(
            'showInformationMessage',
            { contains: expectedPromptMessageSuffix },
            { result: Common.install, clickImmediately: true },
            disposables
        );
    }
    /**
     * Performs a few assertions in this function:
     *
     * 1. Verify IPYKernel installation prompt is displayed.
     * 2. Verify IPYKernel is installed (based on value for the argument for `ipykernelInstallRequirement`)
     * 3. Verify the Kernel points to the right interpreter
     */
    async function openNotebookAndInstallIpyKernelWhenRunningCell(
        interpreterPath: Uri,
        interpreterOfNewKernelToSelect?: Uri,
        ipykernelInstallRequirement: 'DoNotInstallIPyKernel' | 'ShouldInstallIPYKernel' = 'ShouldInstallIPYKernel'
    ) {
        // Highjack the IPyKernel not installed prompt and click the appropriate button.
        let promptToInstall = await (interpreterOfNewKernelToSelect
            ? selectKernelFromIPyKernelPrompt()
            : clickInstallFromIPyKernelPrompt());

        installerSpy = sinon.spy(installer, 'install');

        let selectADifferentKernelStub: undefined | sinon.SinonStub<any[], any>;
        try {
            if (
                !workspace.notebookDocuments.some(
                    (item) => item.uri.fsPath.toLowerCase() === nbFile.fsPath.toLowerCase()
                )
            ) {
                const { editor } = await openNotebook(nbFile);
                await waitForKernelToChange({ interpreterPath }, editor);
            }

            if (interpreterOfNewKernelToSelect) {
                // If we have a separate interpreter specified then configure the prompts such that
                // this will be selected as the new kernel when we display the ipykernel not installed prompt.
                const result = hookupKernelSelected(
                    promptToInstall,
                    interpreterOfNewKernelToSelect,
                    ipykernelInstallRequirement
                );
                selectADifferentKernelStub = result.selectADifferentKernelStub;
            }
            const cell = window.activeNotebookEditor?.notebook.cellAt(0)!;

            await Promise.all([
                runAllCellsInActiveNotebook(),
                waitForCondition(
                    async () => promptToInstall.displayed.then(() => true),
                    delayForUITest,
                    'Prompt not displayed'
                ),
                ipykernelInstallRequirement === 'DoNotInstallIPyKernel'
                    ? Promise.resolve()
                    : waitForIPyKernelToGetInstalled(),
                waitForExecutionCompletedSuccessfully(cell),
                waitForCellHavingOutput(cell)
            ]);

            // Verify the kernel points to the expected interpreter.
            const output = getCellOutputs(cell).trim();
            const expectedInterpreterPath = interpreterOfNewKernelToSelect || interpreterPath;
            assert.isTrue(
                areInterpreterPathsSame(expectedInterpreterPath, Uri.file(output)),
                `Kernel points to ${getDisplayPathFromLocalFile(output)} but expected ${getDisplayPath(
                    expectedInterpreterPath
                )}`
            );

            // Verify ipykernel was not installed if not required && vice versa.
            if (ipykernelInstallRequirement === 'DoNotInstallIPyKernel') {
                if (installerSpy.callCount > 0) {
                    IInstaller;
                    assert.fail(
                        `IPyKernel was installed when it should not have been, here are the calls: ${installerSpy
                            .getCalls()
                            .map((call) => {
                                const args: Parameters<IInstaller['install']> = call.args as any;
                                return `${ProductNames.get(args[0])} ${getDisplayPath(
                                    isUri(args[1]) ? args[1] : args[1]?.uri
                                )}`;
                            })
                            .join('\n')}`
                    );
                }
            }
        } finally {
            promptToInstall.dispose();
            selectADifferentKernelStub?.restore();
            installerSpy.restore();
        }
    }
    function waitForIPyKernelToGetInstalled() {
        return waitForCondition(
            async () => verifyIPyKernelWasInstalled(),
            delayForUITest,
            () =>
                `Prompt not displayed or not installed successfully, call count = ${installerSpy.callCount}, arg0 ${
                    installerSpy.callCount ? installerSpy.getCall(0).args[0] : undefined
                }, result ${installerSpy.callCount ? installerSpy.getCall(0).returnValue : undefined}`
        );
    }
    async function verifyIPyKernelWasInstalled() {
        assert.strictEqual(installerSpy.callCount, 1);
        assert.strictEqual(installerSpy.getCall(0).args[0], Product.ipykernel);
        assert.strictEqual(await installerSpy.getCall(0).returnValue, InstallerResponse.Installed);
        return true;
    }

    function verifyInstallIPyKernelInstructionsInOutput(cell: NotebookCell) {
        const textToLookFor = `install '${ProductNames.get(Product.ipykernel)!}'`;
        const err = translateCellErrorOutput(cell.outputs[0]);
        assert.include(err.traceback.join('').toLowerCase(), textToLookFor.toLowerCase());
        assert.include(err.traceback.join('').toLowerCase(), 'command:');
        return true;
    }
    type Awaited<T> = T extends PromiseLike<infer U> ? U : T;
    function hookupKernelSelected(
        promptToInstall: Awaited<ReturnType<typeof selectKernelFromIPyKernelPrompt>>,
        pythonPathToNewKernel: Uri,
        ipykernelInstallRequirement: 'DoNotInstallIPyKernel' | 'ShouldInstallIPYKernel' = 'ShouldInstallIPYKernel'
    ) {
        // Get the controller that should be selected.
        const controllerManager = api.serviceContainer.get<IControllerRegistration>(IControllerRegistration);
        const controller = controllerManager.registered.find(
            (item) =>
                item.controller.notebookType === JupyterNotebookView &&
                item.connection.kind === 'startUsingPythonInterpreter' &&
                areInterpreterPathsSame(item.connection.interpreter.uri, pythonPathToNewKernel)
        );
        if (!controller) {
            const registeredControllers = controllerManager.registered.map((item) => item.id).join(',');
            throw new Error(
                `Unable to find a controller for ${pythonPathToNewKernel}, registered controllers ids are ${registeredControllers}`
            );
        }

        const kernelSelected = createDeferred<boolean>();
        const selectADifferentKernelStub = sinon.stub(commands, 'executeCommand').callsFake(async function (
            cmd: string
        ) {
            if (cmd === 'notebook.selectKernel') {
                // After we change the kernel, we might get a prompt to install ipykernel.
                // Ensure we click ok to install.
                if (promptToInstall.getDisplayCount() > 0) {
                    promptToInstall.dispose();
                    if (ipykernelInstallRequirement === 'ShouldInstallIPYKernel') {
                        await clickInstallFromIPyKernelPrompt();
                    }
                }
                await (commands.executeCommand as any).wrappedMethod.apply(commands, [
                    'notebook.selectKernel',
                    {
                        id: controller.controller.id,
                        extension: JVSC_EXTENSION_ID_FOR_TESTS
                    }
                ]);

                kernelSelected.resolve(true);
                return Promise.resolve(true);
            } else {
                return (commands.executeCommand as any).wrappedMethod.apply(commands, [
                    cmd,
                    ...Array.from(arguments).slice(1)
                ]);
            }
        } as any);

        return { kernelSelected: kernelSelected.promise, selectADifferentKernelStub };
    }
});
